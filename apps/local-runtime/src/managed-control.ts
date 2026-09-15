import { Buffer } from 'node:buffer';
import {
  HARNESS_PROTOCOL_VERSION,
  HARNESS_RELEASE_VERSION,
  managedControlMessageSchema,
} from '@yanbot-harness/contracts';

type Runtime = { instanceId: string; close(): Promise<void> };

// Install before any asynchronous startup work. Daemon mode has no IPC and no parent policy.
export function createManagedControl() {
  if (!process.send) return undefined;
  let launchId: string | undefined;
  let requestId: string | undefined;
  let runtime: Runtime | undefined;
  let stopping = false;
  let closed: Promise<void> | undefined;
  let accept!: () => void;
  let reject!: (error: Error) => void;
  const hello = new Promise<void>((resolve, fail) => {
    accept = resolve;
    reject = fail;
  });
  void hello.catch(() => undefined);
  const helloTimer = setTimeout(() => fail(), 15000);
  let stopTimer: NodeJS.Timeout | undefined;
  const send = (value: object) => {
    if (process.connected) process.send!(value, () => undefined);
  };
  const stop = () => {
    stopping = true;
    clearTimeout(helloTimer);
    stopTimer ??= setTimeout(() => process.exit(1), 5000);
    if (!runtime) {
      accept();
      return;
    }
    closed ??= runtime
      .close()
      .then(() => {
        if (launchId && requestId)
          send({
            type: 'shutdown-complete',
            managedProtocolVersion: 1,
            launchId,
            requestId,
            pid: process.pid,
            instanceId: runtime!.instanceId,
          });
        if (stopTimer) clearTimeout(stopTimer);
        if (process.connected) process.disconnect();
      })
      .catch(() => {
        process.exitCode = 1;
        if (process.connected) process.disconnect();
      });
  };
  const fail = () => {
    reject(new Error('Invalid managed control channel.'));
    process.exitCode = 1;
    stop();
  };
  const onMessage = (raw: unknown) => {
    try {
      if (Buffer.byteLength(JSON.stringify(raw)) > 8192) throw new Error();
      const message = managedControlMessageSchema.parse(raw);
      if (message.type === 'hello' && !launchId && !stopping) {
        launchId = message.launchId;
        clearTimeout(helloTimer);
        accept();
        return;
      }
      if (
        message.type === 'shutdown' &&
        launchId === message.launchId &&
        (!requestId || requestId === message.requestId)
      ) {
        requestId = message.requestId;
        stop();
        return;
      }
      throw new Error();
    } catch {
      fail();
    }
  };
  process.on('message', onMessage);
  process.once('disconnect', stop);
  return {
    hello,
    get stopping() {
      return stopping;
    },
    finishBeforeStart() {
      clearTimeout(helloTimer);
      if (stopTimer) clearTimeout(stopTimer);
      if (process.connected) process.disconnect();
    },
    ready(value: Runtime) {
      runtime = value;
      if (stopping) {
        stop();
        return;
      }
      send({
        type: 'ready',
        managedProtocolVersion: 1,
        launchId,
        pid: process.pid,
        instanceId: value.instanceId,
        runtimeVersion: HARNESS_RELEASE_VERSION,
        protocolVersion: HARNESS_PROTOCOL_VERSION,
      });
    },
    stop,
    failed() {
      fail();
      if (process.connected) process.disconnect();
    },
  };
}
