import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import {
  HARNESS_RELEASE_VERSION,
  HARNESS_PROTOCOL_VERSION,
  managedControlMessageSchema,
  type ManagedControlMessage,
} from '@yanbot-harness/contracts';

import { HarnessClient } from './client.js';
import { readRuntimeDescriptor } from './daemon.js';
import { protectManagedState, verifyManagedDescriptor } from './managed-permissions.js';
import { HarnessSdkError } from './transport.js';
import { jobHostControl } from './windows-job-host.js';
import { startVMRuntime, type VMContainment, type VMOptions } from './macos-vm-host.js';

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const MIN_TIMEOUT_MS = 100;
const MAX_STARTUP_TIMEOUT_MS = 120_000;
const MAX_SHUTDOWN_TIMEOUT_MS = 30_000;
const executeFile = promisify(execFile);

export type RuntimeLaunchDescriptor = {
  entryPath: string;
  runtimeVersion: string;
  protocolVersion: string;
  managedProtocolVersion: 1;
  containment?: { kind: 'windows-job-v1'; executablePath: string } | VMContainment;
};
export type ManagedRuntimeResolver = (context: { signal: AbortSignal }) => Promise<RuntimeLaunchDescriptor>;
export type StartManagedRuntimeOptions = {
  executablePath?: string;
  environment?: Readonly<Record<string, string | undefined>>;
  stateRoot?: string;
  reference?: boolean;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  runtimeResolver?: ManagedRuntimeResolver;
  nodeExecutablePath?: string;
  /** Fail before spawn unless a verified containment host is supplied by the resolver. */
  requireContainment?: boolean;
  /** Explicit VM resource mappings; no host HOME or ambient environment is shared. */
  vm?: VMOptions;
  fetch?: typeof fetch;
};

export type ManagedRuntimeHandle = {
  readonly client: HarnessClient;
  readonly origin: string;
  readonly pid: number;
  readonly descriptorPath: string;
  close(): Promise<void>;
};

type ChildOutcome =
  | { kind: 'exit'; code: number | null; signal: NodeJS.Signals | null }
  | { kind: 'error'; error: Error };

export async function startManagedRuntime(options: StartManagedRuntimeOptions = {}): Promise<ManagedRuntimeHandle> {
  const startupTimeoutMs = boundedTimeout(
    options.startupTimeoutMs,
    DEFAULT_STARTUP_TIMEOUT_MS,
    MAX_STARTUP_TIMEOUT_MS,
    'startupTimeoutMs',
  );
  const shutdownTimeoutMs = boundedTimeout(
    options.shutdownTimeoutMs,
    DEFAULT_SHUTDOWN_TIMEOUT_MS,
    MAX_SHUTDOWN_TIMEOUT_MS,
    'shutdownTimeoutMs',
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(startTimeout()), startupTimeoutMs);
  const signal = controller.signal;
  const environment = options.environment ?? process.env;
  let child: ChildProcess | undefined;
  let outcome: Promise<ChildOutcome> | undefined;
  let stateRoot: string | undefined;
  let descriptorPath: string | undefined;
  let instanceId: string | undefined;
  let managed: RuntimeLaunchDescriptor | undefined;
  let control: ReturnType<typeof parentControl> | undefined;
  let job: ReturnType<typeof jobHostControl> | undefined;
  const ownsStateRoot = options.stateRoot === undefined;
  try {
    const selectedPath = options.executablePath ?? environment.YANBOT_HARNESS_RUNTIME_PATH;
    const node = options.nodeExecutablePath ?? process.execPath;
    if (options.nodeExecutablePath || selectedPath === undefined) await checkNode(node, signal);
    if (selectedPath === undefined) {
      if (!options.runtimeResolver) missingRuntimePath();
      managed = await withSignal(options.runtimeResolver({ signal }), signal);
      if (
        !path.isAbsolute(managed.entryPath) ||
        managed.runtimeVersion !== HARNESS_RELEASE_VERSION ||
        managed.protocolVersion !== HARNESS_PROTOCOL_VERSION ||
        managed.managedProtocolVersion !== 1
      ) {
        throw new HarnessSdkError('protocol', 'The resolved Runtime version or managed protocol is incompatible.');
      }
    }
    signal.throwIfAborted();
    if (managed?.containment?.kind === 'macos-vm-v1')
      return await startVMRuntime(managed.containment, options, signal, shutdownTimeoutMs);
    const executablePath = path.resolve(selectedPath ?? managed!.entryPath);
    if (options.requireContainment && !managed?.containment)
      throw new HarnessSdkError(
        'runtime',
        'CONTAINMENT_UNAVAILABLE: this Runtime path has no certified containment host.',
      );
    await validateExecutable(executablePath);
    const invocation = await invocationFor(executablePath, node);
    if (managed?.containment) {
      if (
        process.platform !== 'win32' ||
        managed.containment.kind !== 'windows-job-v1' ||
        !path.isAbsolute(managed.containment.executablePath)
      )
        throw new HarnessSdkError('protocol', 'Unsupported containment host descriptor.');
      await validateExecutable(managed.containment.executablePath);
    }
    signal.throwIfAborted();
    stateRoot = ownsStateRoot
      ? await mkdtemp(path.join(tmpdir(), 'yanbot-harness-managed-'))
      : path.resolve(options.stateRoot!);
    await mkdir(stateRoot, { recursive: true, mode: 0o700 });
    descriptorPath = path.join(stateRoot, 'runtime.json');
    await assertDescriptorAbsent(descriptorPath);
    if (managed) await protectManagedState(stateRoot, signal);
    signal.throwIfAborted();
    const runtimeArguments = [...invocation.arguments, ...(options.reference ? ['--reference'] : [])];
    child = spawn(
      managed?.containment?.executablePath ?? invocation.command,
      managed?.containment ? ['--', invocation.command, ...runtimeArguments] : runtimeArguments,
      {
        env: compactEnvironment({ ...environment, YANBOT_HARNESS_STATE_DIR: stateRoot }),
        stdio: managed?.containment
          ? ['pipe', 'pipe', 'pipe', 'ipc']
          : managed
            ? ['ignore', 'ignore', 'ignore', 'ipc']
            : 'ignore',
        detached: Boolean(managed && process.platform !== 'win32'),
        windowsHide: true,
      },
    );
    outcome = observeChild(child);
    if (managed?.containment) job = jobHostControl(child);
    const runtimePid = job ? await withSignal(job.started, signal) : child.pid;
    if (managed) control = parentControl(child, outcome, managed, runtimePid);
    const descriptor = await withSignal(
      waitForDescriptor({ child, outcome, descriptorPath, environment, signal, managed: Boolean(managed) }),
      signal,
    );
    instanceId = descriptor.instanceId;
    if (descriptor.pid !== runtimePid)
      throw new HarnessSdkError('protocol', 'The managed Runtime descriptor belongs to an unexpected process.');
    if (control) {
      const ready = await withSignal(control.ready, signal);
      if (ready.instanceId !== descriptor.instanceId)
        throw new HarnessSdkError('protocol', 'Managed readiness identity mismatch.');
    }
    const client = await withSignal(
      HarnessClient.connect({
        mode: 'local-daemon',
        descriptorPath,
        environment,
        signal,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      }),
      signal,
    );
    control?.assertHealthy();
    signal.throwIfAborted();
    if (child.exitCode !== null || child.signalCode !== null) throw childOutcomeError(await outcome);
    const ownedChild = child;
    const ownedOutcome = outcome;
    const ownedDescriptor = descriptorPath;
    const ownedRoot = ownsStateRoot ? stateRoot : undefined;
    let closePromise: Promise<void> | undefined;
    return {
      client,
      origin: descriptor.origin,
      pid: descriptor.pid,
      descriptorPath,
      close() {
        closePromise ??= (async () => {
          control?.shutdown();
          if (job) await job.terminate(shutdownTimeoutMs);
          else await terminateOwnedChild(ownedChild, ownedOutcome, shutdownTimeoutMs, Boolean(managed));
          control?.dispose();
          control?.assertHealthy();
          await removeOwnedDescriptor(ownedDescriptor, descriptor.instanceId);
          if (ownedRoot) await rm(ownedRoot, { recursive: true, force: true });
        })();
        return closePromise;
      },
    };
  } catch (error) {
    const failure = signal.aborted ? signal.reason : error;
    controller.abort(error);
    try {
      if (child && outcome) {
        control?.shutdown();
        if (job) await job.terminate(shutdownTimeoutMs);
        else await terminateOwnedChild(child, outcome, shutdownTimeoutMs, Boolean(managed));
      }
    } catch {
      throw new HarnessSdkError(
        'runtime',
        'CLEANUP_FAILED: managed process cleanup failed; owned state was retained for diagnosis.',
      );
    } finally {
      control?.dispose();
    }
    if (descriptorPath && instanceId) await removeOwnedDescriptor(descriptorPath, instanceId);
    if (ownsStateRoot && stateRoot) await rm(stateRoot, { recursive: true, force: true });
    if (failure instanceof HarnessSdkError) throw failure;
    throw new HarnessSdkError(
      'runtime',
      'The managed Runtime failed to start. Check resolver integrity, Node compatibility and permissions.',
    );
  } finally {
    clearTimeout(timer);
  }
}

async function checkNode(node: string, signal: AbortSignal): Promise<void> {
  const { stdout } = await executeFile(
    node,
    [
      '--input-type=commonjs',
      '-e',
      'process.stdout.write(JSON.stringify({node:process.versions.node,os:process.platform,cpu:process.arch,electron:Boolean(process.versions.electron)}))',
    ],
    {
      signal,
      windowsHide: true,
      maxBuffer: 4096,
      env: compactEnvironment(
        Object.fromEntries(['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR'].map((key) => [key, process.env[key]])),
      ),
    },
  );
  const identity = JSON.parse(stdout) as { node: string; os: string; cpu: string; electron: boolean };
  // v1 resolver selects the current Node target. Different-architecture injected Node is rejected before resolution.
  const [major, minor] = identity.node.split('.').map(Number);
  if (
    major !== 22 ||
    minor === undefined ||
    minor < 22 ||
    identity.os !== process.platform ||
    identity.cpu !== process.arch ||
    identity.electron
  ) {
    throw new HarnessSdkError(
      'runtime',
      'NODE_UNSUPPORTED: use plain Node >=22.22.0 <23 matching the host architecture.',
    );
  }
}

async function waitForDescriptor(options: {
  managed: boolean;
  child: ChildProcess;
  outcome: Promise<ChildOutcome>;
  descriptorPath: string;
  environment: Readonly<Record<string, string | undefined>>;
  signal: AbortSignal;
}) {
  let settled: ChildOutcome | undefined;
  void options.outcome.then((value) => {
    settled = value;
  });
  while (true) {
    options.signal.throwIfAborted();
    if (settled) throw childOutcomeError(settled);
    if (await isFile(options.descriptorPath)) {
      if (options.managed) await verifyManagedDescriptor(options.descriptorPath, options.signal);
      return readRuntimeDescriptor({ descriptorPath: options.descriptorPath, environment: options.environment });
    }
    await withSignal(delay(50), options.signal);
  }
}

function parentControl(
  child: ChildProcess,
  outcome: Promise<ChildOutcome>,
  expected: RuntimeLaunchDescriptor,
  runtimePid = child.pid,
) {
  const launchId = randomUUID();
  let readyValue: Extract<ManagedControlMessage, { type: 'ready' }> | undefined;
  let shutdownId: string | undefined;
  let protocolFailure: HarnessSdkError | undefined;
  let accept!: (value: Extract<ManagedControlMessage, { type: 'ready' }>) => void;
  let reject!: (error: Error) => void;
  const ready = new Promise<Extract<ManagedControlMessage, { type: 'ready' }>>((resolve, fail) => {
    accept = resolve;
    reject = fail;
  });
  void ready.catch(() => undefined);
  const onMessage = (raw: unknown) => {
    try {
      if (Buffer.byteLength(JSON.stringify(raw)) > 8192) throw new Error();
      const message = managedControlMessageSchema.parse(raw);
      if (message.launchId !== launchId) throw new Error();
      if (
        message.type === 'ready' &&
        !readyValue &&
        !shutdownId &&
        message.pid === runtimePid &&
        message.runtimeVersion === expected.runtimeVersion &&
        message.protocolVersion === expected.protocolVersion
      ) {
        readyValue = message;
        accept(message);
        return;
      }
      if (
        message.type === 'shutdown-complete' &&
        shutdownId === message.requestId &&
        message.pid === runtimePid &&
        message.instanceId === readyValue?.instanceId
      )
        return;
      throw new Error();
    } catch {
      protocolFailure = new HarnessSdkError('protocol', 'Invalid managed control message.');
      reject(protocolFailure);
      if (child.connected) child.disconnect();
    }
  };
  child.on('message', onMessage);
  void outcome.then((value) => reject(childOutcomeError(value)));
  child.send({ managedProtocolVersion: 1, type: 'hello', launchId }, (error) => {
    if (error) reject(new HarnessSdkError('runtime', 'Managed IPC could not be opened.'));
  });
  return {
    ready,
    assertHealthy() {
      if (protocolFailure) throw protocolFailure;
    },
    shutdown() {
      if (shutdownId || !child.connected) return;
      shutdownId = randomUUID();
      child.send({ managedProtocolVersion: 1, type: 'shutdown', launchId, requestId: shutdownId }, () => undefined);
    },
    dispose() {
      child.off('message', onMessage);
      if (child.connected) child.disconnect();
    },
  };
}

async function terminateOwnedChild(
  child: ChildProcess,
  outcome: Promise<ChildOutcome>,
  timeoutMs: number,
  managed = false,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(1, deadline - Date.now());
  if (child.pid === undefined) {
    await settlesWithin(outcome, remaining());
    return;
  }
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  if (managed && !exited()) await settlesWithin(outcome, Math.max(1, Math.floor(timeoutMs * 0.6)));
  if (process.platform === 'win32') {
    // Never taskkill a PID after our child has exited: Windows may already have reused it.
    if (!exited()) {
      const systemRoot = process.env.SystemRoot;
      if (!systemRoot)
        throw new HarnessSdkError('runtime', 'Windows SystemRoot is required for owned process cleanup.');
      await executeFile(path.join(systemRoot, 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], {
        timeout: remaining(),
        windowsHide: true,
      }).catch((error: unknown) => {
        if (!exited()) throw error;
      });
    }
  } else if (managed) {
    // New Runtime is a group leader. Detached descendants remain a separate certification gate.
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if (!isMissingProcess(error)) throw error;
    }
  } else if (!exited()) {
    child.kill('SIGTERM');
    if (!(await settlesWithin(outcome, Math.max(1, Math.floor(remaining() * 0.6))))) child.kill('SIGKILL');
  }
  if (!(await settlesWithin(outcome, remaining())))
    throw new HarnessSdkError('runtime', 'CLEANUP_FAILED: Runtime did not exit within shutdownTimeoutMs.');
}

function isMissingProcess(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH';
}
function startTimeout() {
  return new HarnessSdkError('runtime', 'The managed Runtime did not become ready before the startup timeout.');
}
async function withSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([promise, cancelled]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

function observeChild(child: ChildProcess): Promise<ChildOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: ChildOutcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    child.once('error', (error) => finish({ kind: 'error', error }));
    child.once('exit', (code, signal) => finish({ kind: 'exit', code, signal }));
  });
}

function childOutcomeError(outcome: ChildOutcome): HarnessSdkError {
  if (outcome.kind === 'error') {
    return new HarnessSdkError('runtime', 'The managed Runtime process could not be started.', {
      cause: outcome.error,
    });
  }
  const detail = outcome.signal === null ? `exit code ${outcome.code ?? 'unknown'}` : `signal ${outcome.signal}`;
  return new HarnessSdkError('runtime', `The managed Runtime exited before it became ready (${detail}).`);
}

async function validateExecutable(file: string): Promise<void> {
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
  } catch (error) {
    throw new HarnessSdkError('runtime', 'The managed Runtime executable could not be found.', { cause: error });
  }
}

async function assertDescriptorAbsent(file: string): Promise<void> {
  try {
    await stat(file);
  } catch (error) {
    if (isMissing(error)) return;
    throw new HarnessSdkError('runtime', 'The managed Runtime state directory could not be inspected.', {
      cause: error,
    });
  }
  throw new HarnessSdkError(
    'runtime',
    'The managed Runtime state directory already contains a descriptor. Use a dedicated state directory.',
  );
}

async function removeOwnedDescriptor(file: string, instanceId: string): Promise<void> {
  try {
    const value = JSON.parse(await readFile(file, 'utf8')) as { instanceId?: unknown };
    if (value.instanceId === instanceId) await rm(file, { force: true });
  } catch (error) {
    if (!isMissing(error)) {
      throw new HarnessSdkError('runtime', 'The managed Runtime descriptor could not be cleaned up.', {
        cause: error,
      });
    }
  }
}

async function invocationFor(executablePath: string, node: string): Promise<{ command: string; arguments: string[] }> {
  if (/\.(?:cmd|bat)$/iu.test(executablePath)) {
    const nodeLauncher = executablePath.replace(/\.(?:cmd|bat)$/iu, '.js');
    try {
      await validateExecutable(nodeLauncher);
    } catch (error) {
      throw new HarnessSdkError(
        'runtime',
        'A managed Windows Runtime batch launcher requires the same-name .js launcher from the release bundle.',
        { cause: error },
      );
    }
    return { command: node, arguments: [nodeLauncher] };
  }
  return /\.[cm]?js$/iu.test(executablePath)
    ? { command: node, arguments: [executablePath] }
    : { command: executablePath, arguments: [] };
}

function compactEnvironment(environment: Readonly<Record<string, string | undefined>>): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function boundedTimeout(value: number | undefined, fallback: number, maximum: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < MIN_TIMEOUT_MS || resolved > maximum) {
    throw new HarnessSdkError('request', `${name} must be between ${MIN_TIMEOUT_MS} and ${maximum} milliseconds.`);
  }
  return Math.floor(resolved);
}

async function settlesWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function missingRuntimePath(): never {
  throw new HarnessSdkError(
    'runtime',
    'A managed Runtime executable is required. Set executablePath or YANBOT_HARNESS_RUNTIME_PATH.',
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
