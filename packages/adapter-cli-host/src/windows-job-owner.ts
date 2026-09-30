import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { CliHostError, type CliHostProcessOwner } from './runner.js';

/** Native path must come from the caller's verified installation, not a Run parameter. */
export function createWindowsCliJobOwner(nativeExecutablePath: string): CliHostProcessOwner {
  if (!path.isAbsolute(nativeExecutablePath) || nativeExecutablePath.includes('\0')) {
    throw new CliHostError('INVALID_LAUNCH', 'Native CLI Job host requires an absolute executable path.');
  }
  const owned = new WeakMap<ChildProcess, ReturnType<typeof observeCliJob>>();
  return {
    spawn(launch) {
      if (process.platform !== 'win32')
        throw new CliHostError('INVALID_LAUNCH', 'Native CLI Job host requires Windows.');
      const child = spawn(nativeExecutablePath, ['--', launch.executablePath, ...launch.args], {
        cwd: launch.workingDirectory,
        env: { ...launch.environment },
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
      });
      const lease = child.stdin!;
      const control = child.stdio[3] as Readable;
      const vendorInput = child.stdio[4] as Writable;
      owned.set(child, observeCliJob(child, control, lease));
      // Preserve the native lease privately while exposing only vendor stdin to protocol clients.
      Object.defineProperty(child, 'stdin', { value: vendorInput, enumerable: true, configurable: true });
      return child;
    },
    async terminate(child, timeoutMs) {
      const control = owned.get(child);
      if (!control) throw new CliHostError('CLEANUP_UNVERIFIED', 'Unknown native CLI Job owner.');
      await control.terminate(timeoutMs);
    },
    async verifyClosed(child, timeoutMs) {
      const control = owned.get(child);
      if (!control) throw new CliHostError('CLEANUP_UNVERIFIED', 'Unknown native CLI Job owner.');
      await control.terminate(timeoutMs);
    },
  };
}

export function observeCliJob(child: ChildProcess, control: Readable, lease: Writable) {
  let buffer = '';
  let bytes = 0;
  let started = false;
  let exitCode: number | undefined;
  let failure: CliHostError | undefined;
  let terminating: Promise<void> | undefined;
  const invalid = () => {
    failure ??= new CliHostError('CLEANUP_UNVERIFIED', 'Invalid native CLI Job proof.');
    lease.destroy();
  };
  control.setEncoding('utf8');
  control.on('error', invalid);
  lease.on('error', () => {
    if (exitCode === undefined) invalid();
  });
  control.on('data', (chunk: string) => {
    bytes += Buffer.byteLength(chunk);
    if (failure || bytes > 4096) {
      invalid();
      return;
    }
    buffer += chunk;
    for (;;) {
      const end = buffer.indexOf('\n');
      if (end === -1) return;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        const message: Record<string, unknown> = JSON.parse(line);
        if (message.protocolVersion !== 1) throw new Error();
        const keys = Object.keys(message).sort().join(',');
        if (
          message.type === 'started' &&
          !started &&
          exitCode === undefined &&
          keys === 'childPid,hostPid,protocolVersion,type' &&
          message.hostPid === child.pid &&
          validUint(message.childPid) &&
          message.childPid !== 0
        ) {
          started = true;
        } else if (
          message.type === 'stopped' &&
          started &&
          exitCode === undefined &&
          keys === 'activeProcesses,exitCode,protocolVersion,type' &&
          message.activeProcesses === 0 &&
          validUint(message.exitCode)
        ) {
          exitCode = message.exitCode;
        } else throw new Error();
      } catch {
        invalid();
        return;
      }
    }
  });
  const closed = new Promise<void>((resolve, reject) => {
    child.once('error', () => reject(new CliHostError('SPAWN_ERROR', 'Native CLI Job host could not start.')));
    child.once('close', (code, signal) => {
      if (
        failure ||
        !started ||
        exitCode === undefined ||
        code === null ||
        code >>> 0 !== exitCode ||
        signal !== null ||
        buffer.length !== 0
      ) {
        reject(
          failure ?? new CliHostError('CLEANUP_UNVERIFIED', 'Native CLI Job provided no matching empty-tree proof.'),
        );
      } else resolve();
    });
  });
  void closed.catch(() => undefined);
  return {
    terminate(timeoutMs: number): Promise<void> {
      terminating ??= (async () => {
        let timer: NodeJS.Timeout | undefined;
        try {
          if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 30_000) throw new Error();
          if (child.exitCode === null && child.signalCode === null && !lease.destroyed) lease.end('stop\n');
          await Promise.race([
            closed,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error()), timeoutMs);
            }),
          ]);
        } catch {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
          throw new CliHostError('CLEANUP_UNVERIFIED', 'Native CLI Job cleanup could not be verified.');
        } finally {
          clearTimeout(timer);
        }
      })();
      return terminating;
    },
  };
}

function validUint(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff;
}
