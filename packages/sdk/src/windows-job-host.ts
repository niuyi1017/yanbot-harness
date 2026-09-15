import type { ChildProcess } from 'node:child_process';
import { HarnessSdkError } from './transport.js';

// The native host owns this stream exclusively; Runtime stdout is NUL, not a control transport.
export function jobHostControl(child: ChildProcess) {
  let accept!: (pid: number) => void;
  let reject!: (error: Error) => void;
  const started = new Promise<number>((resolve, fail) => {
    accept = resolve;
    reject = fail;
  });
  void started.catch(() => undefined);
  let buffer = '';
  let bytes = 0;
  let runtimePid: number | undefined;
  let stopped = false;
  let failure: HarnessSdkError | undefined;
  const invalid = () => {
    failure ??= new HarnessSdkError('protocol', 'Invalid native containment host control message.');
    reject(failure);
    child.stdin?.destroy();
  };
  child.stdout?.setEncoding('utf8');
  child.stderr?.resume(); // Native diagnostics contain fixed stage/code only, never forward arbitrary output.
  child.stdout?.on('data', (chunk: string) => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 4096 || failure) {
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
        const message = JSON.parse(line) as Record<string, unknown>;
        if (message.protocolVersion !== 1) throw new Error();
        if (
          message.type === 'started' &&
          runtimePid === undefined &&
          !stopped &&
          Object.keys(message).join(' ') === 'protocolVersion type hostPid runtimePid' &&
          message.hostPid === child.pid &&
          typeof message.runtimePid === 'number' &&
          Number.isSafeInteger(message.runtimePid) &&
          message.runtimePid > 0 &&
          message.runtimePid <= 0xffffffff
        ) {
          runtimePid = message.runtimePid;
          accept(runtimePid);
        } else if (
          message.type === 'stopped' &&
          runtimePid !== undefined &&
          !stopped &&
          Object.keys(message).join(' ') === 'protocolVersion type activeProcesses' &&
          message.activeProcesses === 0
        ) {
          stopped = true;
        } else throw new Error();
      } catch {
        invalid();
      }
    }
  });
  child.stdin?.on('error', () => undefined); // EPIPE is checked through the host's close/proof outcome.
  const closed = new Promise<void>((resolve, fail) => {
    child.once('error', () => {
      reject(new HarnessSdkError('runtime', 'Native containment host could not start.'));
      fail(new HarnessSdkError('runtime', 'Native containment host could not start.'));
    });
    child.once('close', (code, signal) => {
      if (runtimePid === undefined) reject(new HarnessSdkError('runtime', 'Native host exited before readiness.'));
      if (failure || code !== 0 || signal !== null || !stopped || buffer.length !== 0)
        fail(failure ?? new HarnessSdkError('runtime', 'CLEANUP_FAILED: native host provided no empty-Job proof.'));
      else resolve();
    });
  });
  void closed.catch(() => undefined);
  return {
    started,
    async terminate(timeoutMs: number) {
      const deadline = Date.now() + timeoutMs;
      try {
        const graceful = await Promise.race([
          closed.then(() => true),
          pause(Math.max(1, Math.floor(timeoutMs * 0.6))).then(() => false),
        ]);
        if (graceful) return;
        child.stdin?.end('stop\n');
        await within(closed, Math.max(1, deadline - Date.now()));
      } catch (error) {
        // ChildProcess.kill uses its owned process handle; no PID-based reopen/taskkill after host exit.
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        throw error;
      }
    },
  };
}

function pause(ms: number) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}
async function within(promise: Promise<void>, ms: number) {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new HarnessSdkError('runtime', 'CLEANUP_FAILED: native Job drain timed out.')),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
