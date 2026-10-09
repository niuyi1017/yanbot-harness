import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { TextDecoder } from 'node:util';

export type VendorLaunch = {
  executablePath: string;
  args: readonly string[];
  workingDirectory?: string;
  environment: Readonly<Record<string, string>>;
};

/** Called on every exit path, including after the leader exits; must release the original tree owner. */
export interface CliHostProcessOwner {
  spawn(launch: VendorLaunch): ChildProcess;
  terminate(child: ChildProcess, timeoutMs: number): Promise<void>;
  verifyClosed?(child: ChildProcess, timeoutMs: number): Promise<void>;
}

export type CliHostOptions = VendorLaunch & {
  stdinText?: string;
  /** Deployment-owned bidirectional input. Each write and the total are bounded. */
  onInputReady?: (input: { write(text: string): Promise<void>; end(): void }) => void | Promise<void>;
  onStdoutLine?: (line: string) => void | Promise<void>;
  signal?: AbortSignal;
  processOwner?: CliHostProcessOwner;
  startupTimeoutMs?: number;
  runTimeoutMs?: number;
  idleTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  maxLineBytes?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
};

export type CliHostResult = {
  exitCode: 0;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutLines: number;
};

export class CliHostError extends Error {
  constructor(
    readonly code:
      | 'INVALID_LAUNCH'
      | 'SPAWN_ERROR'
      | 'PROCESS_EXIT'
      | 'NONZERO_EXIT'
      | 'PARSER_ERROR'
      | 'RESOURCE_LIMIT'
      | 'STARTUP_TIMEOUT'
      | 'RUN_TIMEOUT'
      | 'IDLE_TIMEOUT'
      | 'CANCELLED'
      | 'CREDENTIAL_ERROR'
      | 'CREDENTIAL_CLEANUP_FAILED'
      | 'CLEANUP_UNVERIFIED',
    message: string,
  ) {
    super(message);
    this.name = 'CliHostError';
  }
}

/** Execute one vendor CLI invocation without passing raw vendor output to the platform. */
export async function runVendorCli(options: CliHostOptions): Promise<CliHostResult> {
  validateLaunch(options);
  if (
    options.stdinText !== undefined &&
    (typeof options.stdinText !== 'string' || Buffer.byteLength(options.stdinText) > 4 * 1024 * 1024)
  ) {
    throw new CliHostError('RESOURCE_LIMIT', 'Vendor CLI input exceeded its limit.');
  }
  const startupTimeoutMs = bounded(options.startupTimeoutMs, 15_000, 100, 120_000);
  const runTimeoutMs = bounded(options.runTimeoutMs, 600_000, 100, 3_600_000);
  const idleTimeoutMs = bounded(options.idleTimeoutMs, 120_000, 100, 1_800_000);
  const shutdownTimeoutMs = bounded(options.shutdownTimeoutMs, 5_000, 100, 30_000);
  const maxLineBytes = bounded(options.maxLineBytes, 4 * 1024 * 1024, 64, 16 * 1024 * 1024);
  const maxStdoutBytes = bounded(options.maxStdoutBytes, 64 * 1024 * 1024, 1_024, 256 * 1024 * 1024);
  const maxStderrBytes = bounded(options.maxStderrBytes, 64 * 1024, 1_024, 1024 * 1024);
  if (options.signal?.aborted) throw new CliHostError('CANCELLED', 'Vendor CLI invocation was cancelled.');
  if (process.platform === 'win32' && options.processOwner === undefined) {
    throw new CliHostError('INVALID_LAUNCH', 'Windows vendor CLI requires a native process-tree owner.');
  }
  try {
    if (!(await stat(options.executablePath)).isFile()) throw new Error('Not a file');
    await access(options.executablePath, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
  } catch {
    throw new CliHostError('SPAWN_ERROR', 'Vendor CLI could not start.');
  }
  if (options.signal?.aborted) throw new CliHostError('CANCELLED', 'Vendor CLI invocation was cancelled.');
  const owner = options.processOwner ?? posixProcessOwner;
  let child: ChildProcess;
  try {
    child = owner.spawn(options);
  } catch {
    throw new CliHostError('SPAWN_ERROR', 'Vendor CLI could not start.');
  }
  let timer: NodeJS.Timeout | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  let startupTimer: NodeJS.Timeout | undefined;
  let stopped = false;
  let cleanup: Promise<void> | undefined;
  const cleanupOwner = () => {
    cleanup ??= Promise.resolve()
      .then(() => owner.terminate(child, shutdownTimeoutMs))
      .catch(() => {
        throw new CliHostError('CLEANUP_UNVERIFIED', 'Vendor CLI process-tree cleanup could not be verified.');
      });
    return cleanup;
  };
  let rejectFailure!: (error: CliHostError) => void;
  const failure = new Promise<never>((_, reject: (error: CliHostError) => void) => {
    rejectFailure = reject;
  });
  const fail = (error: CliHostError) => {
    stopped = true;
    rejectFailure(error);
  };
  child.stdin?.on('error', () => fail(new CliHostError('PROCESS_EXIT', 'Vendor CLI input pipe failed.')));
  const onAbort = () => fail(new CliHostError('CANCELLED', 'Vendor CLI invocation was cancelled.'));
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', () => reject(new CliHostError('SPAWN_ERROR', 'Vendor CLI process failed.')));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  void closed.catch(() => undefined);
  try {
    const spawned = new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve());
      child.once('error', () => reject(new CliHostError('SPAWN_ERROR', 'Vendor CLI could not start.')));
    });
    await Promise.race([
      spawned,
      failure,
      new Promise<never>((_, reject) => {
        startupTimer = setTimeout(
          () => reject(new CliHostError('STARTUP_TIMEOUT', 'Vendor CLI startup timed out.')),
          startupTimeoutMs,
        );
      }),
    ]);
    clearTimeout(startupTimer);
    if (!child.stdout || !child.stderr) throw new CliHostError('SPAWN_ERROR', 'Vendor CLI pipes are unavailable.');
    timer = setTimeout(() => fail(new CliHostError('RUN_TIMEOUT', 'Vendor CLI run timed out.')), runTimeoutMs);
    if (options.onInputReady) {
      if (!child.stdin) throw new CliHostError('SPAWN_ERROR', 'Vendor CLI input is unavailable.');
      let inputBytes = 0;
      await Promise.race([
        Promise.resolve(
          options.onInputReady({
            write: async (text) => {
              const bytes = Buffer.byteLength(text);
              if (stopped || bytes > 4 * 1024 * 1024 || (inputBytes += bytes) > 16 * 1024 * 1024)
                throw new CliHostError('RESOURCE_LIMIT', 'Vendor CLI input limit.');
              await new Promise<void>((resolve, reject) =>
                child.stdin!.write(text, (error) =>
                  error ? reject(new CliHostError('PROCESS_EXIT', 'Vendor CLI input closed.')) : resolve(),
                ),
              );
            },
            end: () => child.stdin!.end(),
          }),
        ),
        failure,
      ]);
    } else child.stdin?.end(options.stdinText);
    const markActivity = () => {
      if (stopped) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => fail(new CliHostError('IDLE_TIMEOUT', 'Vendor CLI output became idle.')),
        idleTimeoutMs,
      );
    };
    markActivity();
    const output = readStdout(
      child.stdout,
      maxLineBytes,
      maxStdoutBytes,
      options.onStdoutLine,
      markActivity,
      () => stopped,
    );
    const diagnostics = drainStderr(child.stderr, maxStderrBytes);
    const [stdout, stderr, outcome] = await Promise.race([Promise.all([output, diagnostics, closed]), failure]);
    if (outcome.code !== 0 || outcome.signal !== null) {
      throw new CliHostError(outcome.code === null ? 'PROCESS_EXIT' : 'NONZERO_EXIT', 'Vendor CLI exited abnormally.');
    }
    await cleanupOwner();
    return { exitCode: 0, stdoutBytes: stdout.bytes, stderrBytes: stderr, stdoutLines: stdout.lines };
  } catch (error) {
    stopped = true;
    if (child.pid !== undefined) await cleanupOwner();
    if (error instanceof CliHostError) throw error;
    throw new CliHostError('PROCESS_EXIT', 'Vendor CLI stream failed.');
  } finally {
    stopped = true;
    clearTimeout(startupTimer);
    clearTimeout(timer);
    clearTimeout(idleTimer);
    options.signal?.removeEventListener('abort', onAbort);
    child.stdin?.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
  }
}

export async function probeVendorVersion(
  launch: VendorLaunch,
  options: Omit<CliHostOptions, keyof VendorLaunch | 'onStdoutLine'> = {},
): Promise<string> {
  let version: string | undefined;
  await runVendorCli({
    ...launch,
    ...options,
    maxLineBytes: 4_096,
    maxStdoutBytes: 8_192,
    onStdoutLine: (line) => {
      const value = line.trim();
      if (version === undefined && value.length > 0) version = value;
    },
  });
  if (!version || version.length > 256) throw new CliHostError('PARSER_ERROR', 'Vendor CLI version is unavailable.');
  return version;
}

async function readStdout(
  stream: NodeJS.ReadableStream,
  lineLimit: number,
  outputLimit: number,
  onLine: CliHostOptions['onStdoutLine'],
  markActivity: () => void,
  isStopped: () => boolean,
): Promise<{ bytes: number; lines: number }> {
  let total = 0;
  let lineBytes = 0;
  let lines = 0;
  let parts: Buffer[] = [];
  const emit = async () => {
    const bytes = Buffer.concat(parts, lineBytes);
    parts = [];
    lineBytes = 0;
    let line: string;
    try {
      const content = bytes.at(-1) === 0x0d ? bytes.subarray(0, -1) : bytes;
      line = new TextDecoder('utf-8', { fatal: true }).decode(content);
    } catch {
      throw new CliHostError('PARSER_ERROR', 'Vendor CLI output is not valid UTF-8.');
    }
    lines += 1;
    try {
      if (!isStopped()) await onLine?.(line);
    } catch {
      throw new CliHostError('PARSER_ERROR', 'Vendor CLI output parser failed.');
    }
  };
  for await (const value of stream) {
    if (isStopped()) break;
    const chunk = Buffer.isBuffer(value)
      ? value
      : typeof value === 'string'
        ? Buffer.from(value)
        : Buffer.from(value as Uint8Array);
    total += chunk.length;
    if (total > outputLimit) throw new CliHostError('RESOURCE_LIMIT', 'Vendor CLI output exceeded its limit.');
    markActivity();
    let cursor = 0;
    while (cursor < chunk.length) {
      const end = chunk.indexOf(0x0a, cursor);
      const part = chunk.subarray(cursor, end === -1 ? chunk.length : end);
      if (lineBytes + part.length > lineLimit) {
        throw new CliHostError('RESOURCE_LIMIT', 'Vendor CLI output line exceeded its limit.');
      }
      if (part.length > 0) {
        parts.push(part);
        lineBytes += part.length;
      }
      if (end === -1) break;
      await emit();
      if (isStopped()) return { bytes: total, lines };
      cursor = end + 1;
    }
  }
  if (lineBytes > 0 && !isStopped()) await emit();
  return { bytes: total, lines };
}

async function drainStderr(stream: NodeJS.ReadableStream, limit: number): Promise<number> {
  let total = 0;
  for await (const value of stream) {
    total += Buffer.isBuffer(value) ? value.length : Buffer.byteLength(value as string);
    if (total > limit) throw new CliHostError('RESOURCE_LIMIT', 'Vendor CLI diagnostic output exceeded its limit.');
  }
  return total;
}

const posixProcessOwner: CliHostProcessOwner = {
  spawn(launch) {
    return spawn(launch.executablePath, [...launch.args], {
      cwd: launch.workingDirectory,
      env: { ...launch.environment },
      shell: false,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  },
  async terminate(child, timeoutMs) {
    const pid = child.pid;
    if (pid === undefined) {
      throw new CliHostError('CLEANUP_UNVERIFIED', 'Vendor CLI process-tree ownership is unavailable.');
    }
    const deadline = Date.now() + timeoutMs;
    if (child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch (error) {
        if (!missingProcess(error)) throw error;
      }
      await closesWithin(child, Math.max(10, Math.floor(timeoutMs * 0.6)));
    }
    if (child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch (error) {
        if (!missingProcess(error)) throw error;
      }
      await closesWithin(child, Math.max(10, deadline - Date.now()));
    }
    // Once the leader exits, never send another signal through its reusable PID.
    for (;;) {
      try {
        process.kill(-pid, 0);
      } catch (error) {
        if (missingProcess(error)) return;
        throw error;
      }
      if (Date.now() >= deadline) {
        throw new CliHostError('CLEANUP_UNVERIFIED', 'Vendor CLI process group remains after leader exit.');
      }
      await delay(Math.min(25, Math.max(1, deadline - Date.now())));
    }
  },
};

function validateLaunch(launch: VendorLaunch): void {
  if (!path.isAbsolute(launch.executablePath) || launch.executablePath.includes('\0')) {
    throw new CliHostError('INVALID_LAUNCH', 'Vendor CLI executable must be an absolute path.');
  }
  if (launch.workingDirectory !== undefined && !path.isAbsolute(launch.workingDirectory)) {
    throw new CliHostError('INVALID_LAUNCH', 'Vendor CLI working directory must be an absolute path.');
  }
  if (
    !Array.isArray(launch.args) ||
    launch.args.some((arg) => typeof arg !== 'string' || arg.includes('\0')) ||
    Object.entries(launch.environment).some(
      ([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || value.includes('\0'),
    )
  ) {
    throw new CliHostError('INVALID_LAUNCH', 'Invalid vendor CLI argument or environment.');
  }
}

function bounded(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) {
    throw new CliHostError('RESOURCE_LIMIT', 'Invalid vendor CLI resource limit.');
  }
  return selected;
}

function missingProcess(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH';
}

async function closesWithin(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      new Promise<boolean>((resolve) => child.once('close', () => resolve(true))),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
