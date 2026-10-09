import { GuestCheckpointChannel, GuestModelChannel } from '@yanbot-harness/sandbox-model-channel';
import { createWorkspaceSnapshot } from '@yanbot-harness/workspace-snapshot';
import { TextDecoder } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ReferenceAdapter } from '@yanbot-harness/adapter-reference';
import { ClaudeCodeCliAdapter } from '@yanbot-harness/adapter-claude-code-cli';
import { AdapterEventFactory } from '@yanbot-harness/adapter-kit';
import { HarnessAdapterError } from '@yanbot-harness/adapter-api';
import type { HarnessAdapter, AdapterRuntime } from '@yanbot-harness/adapter-api';
import { sidecarRequestSchema } from '@yanbot-harness/adapter-sidecar';
import { HARNESS_PROTOCOL_VERSION, type AdapterEvent, type HarnessCapabilities } from '@yanbot-harness/contracts';

let stateChannel: GuestCheckpointChannel | undefined;
let modelChannel: GuestModelChannel | undefined;
let adapter: HarnessAdapter | undefined;
let runtime: AdapterRuntime | undefined;
let capabilities: HarnessCapabilities | undefined;
let active: { runId: string; done: Promise<void> } | undefined;
let lastLease = Date.now();
let stopping = false;
// This process is container PID 1. Exit on expired lease even if an adapter ignores cancellation.
const lease = setInterval(() => {
  if (Date.now() - lastLease > 10_000) process.exit(70);
}, 500);
const write = (value: unknown) =>
  new Promise<void>((resolve, reject) =>
    process.stdout.write(`${JSON.stringify(value)}\n`, (error) => (error ? reject(error) : resolve())),
  );

async function stop() {
  stopping = true;
  stateChannel?.close();
  modelChannel?.setEnabled(false);
  if (active) await runtime?.cancel({ runId: active.runId });
  await active?.done.catch(() => undefined);
  await runtime?.dispose();
  await modelChannel?.close();
  clearInterval(lease);
}
async function handle(value: unknown) {
  if (typeof value !== 'object' || !value || !('method' in value)) throw new Error('Invalid input');
  if (value.method === 'boot') {
    if (adapter || !('adapterId' in value) || !('files' in value)) throw new Error('Invalid boot');
    await restoreSnapshot(value.files);
    if ('checkpoint' in value && value.checkpoint === true) stateChannel = new GuestCheckpointChannel(write);
    if (value.adapterId === 'cn.yanbot.reference')
      adapter = new ReferenceAdapter(
        process.env.HARNESS_SANDBOX_REFERENCE_WAIT === '1' ? { scenario: { kind: 'wait-for-cancel' } } : {},
      );
    else if (value.adapterId === 'cn.tencent.codebuddy') {
      const { CodeBuddyAdapter } = await import('@yanbot-harness/adapter-codebuddy');
      if ('modelBridge' in value && value.modelBridge === true) {
        modelChannel = new GuestModelChannel(write, 'codebuddy');
        const loopbackOrigin = await modelChannel.listen();
        adapter = new CodeBuddyAdapter({ modelBridge: { loopbackOrigin, token: modelChannel.token } });
      } else adapter = new CodeBuddyAdapter();
    } else if (value.adapterId === 'com.anthropic.claude-code-cli') {
      if ('modelBridge' in value && value.modelBridge === true) {
        modelChannel = new GuestModelChannel(write);
        const loopbackOrigin = await modelChannel.listen();
        adapter = new ClaudeCodeCliAdapter({
          executablePath: '/opt/claude/claude',
          loopbackOrigin,
          apiKey: modelChannel.token,
        });
      } else adapter = new ClaudeCodeCliAdapter({ executablePath: '/opt/claude/claude' });
    } else throw new Error('Unsupported adapter');
    return;
  }
  if (!adapter) throw new Error('Missing boot');
  if (value.method === 'lease') {
    lastLease = Date.now();
    return;
  }
  if (value.method === 'state.saved') {
    if (!stateChannel) throw new Error('Unexpected checkpoint acknowledgement');
    stateChannel.accept(value);
    return;
  }
  if (value.method === 'model.response') {
    if (!modelChannel) throw new Error('Unexpected model response');
    modelChannel.accept(value);
    return;
  }
  const request = sidecarRequestSchema.parse(value);
  const respond = (result: unknown) => write({ jsonrpc: '2.0', id: request.id, result });
  const reject = () =>
    write({ jsonrpc: '2.0', id: request.id, error: { code: -32602, message: 'Unsupported sandbox request.' } });
  if (stopping) return reject();
  if (request.method === 'initialize') {
    if (runtime || request.params.protocolVersion !== HARNESS_PROTOCOL_VERSION) return reject();
    runtime = await adapter.createRuntime({});
    capabilities = {
      ...(await runtime.capabilities()),
      'sessions.resume': stateChannel
        ? { level: 'emulated', reason: 'Host restores committed workspace and conversation context.' }
        : { level: 'unsupported', reason: 'Checkpoint storage is not connected.' },
      ...(adapter.manifest.adapterId === 'cn.tencent.codebuddy'
        ? { 'models.list': { level: 'unsupported' as const, reason: 'Sandbox model discovery is not certified.' } }
        : {}),
    };
    return respond({
      protocolVersion: HARNESS_PROTOCOL_VERSION,
      manifest: { ...adapter.manifest, runtimeKinds: ['sidecar'] },
      capabilities,
    });
  }
  if (!runtime) return reject();
  if (request.method === 'probe') return respond(await adapter.probe({}));
  if (request.method === 'capabilities') return respond(capabilities);
  if (request.method === 'listModels')
    return runtime.listModels
      ? respond({
          models: await runtime.listModels(
            request.params.refresh === undefined ? {} : { refresh: request.params.refresh },
          ),
        })
      : reject();
  if (request.method === 'startRun') {
    if (
      active ||
      request.params.adapterSessionId ||
      request.params.extensions.length ||
      request.params.configScopes.length ||
      (modelChannel && !request.params.model)
    )
      return reject();
    await respond({});
    modelChannel?.setEnabled(true);
    const selectedRuntime = runtime;
    const selectedAdapterId = adapter.manifest.adapterId;
    const done = (async () => {
      let emitted = false;
      try {
        for await (const event of selectedRuntime.startRun({ ...request.params, cwd: '/home/sandbox/workspace' })) {
          emitted = true;
          let normalized: AdapterEvent =
            event.type === 'session.initialized'
              ? { ...event, payload: { ...event.payload, capabilities: capabilities! } }
              : event;
          if (event.type === 'run.completed' && stateChannel) {
            try {
              await stateChannel.save(await createWorkspaceSnapshot('/home/sandbox/workspace'));
            } catch {
              normalized = {
                ...event,
                type: 'run.failed',
                payload: {
                  error: {
                    code: 'HARNESS_FAILED',
                    message: 'The session checkpoint could not be committed.',
                    retryable: false,
                  },
                },
              };
            }
          }
          await write({ jsonrpc: '2.0', method: 'event', params: normalized });
        }
      } catch (error) {
        if (emitted) throw error;
        const factory = new AdapterEventFactory(request.params);
        await write({
          jsonrpc: '2.0',
          method: 'event',
          params: factory.create('run.started', { adapterId: selectedAdapterId }),
        });
        await write({
          jsonrpc: '2.0',
          method: 'event',
          params: factory.create('run.failed', {
            error: {
              code: error instanceof HarnessAdapterError ? error.code : 'HARNESS_FAILED',
              message: 'Sandbox Adapter could not start the requested run.',
              retryable: false,
            },
          }),
        });
      }
    })();
    active = { runId: request.params.runId, done };
    void done
      .catch(() => process.exit(71))
      .finally(() => {
        modelChannel?.setEnabled(false);
        active = undefined;
      });
    return;
  }
  if (request.method === 'respondToInteraction') {
    if (!runtime.respondToInteraction) return reject();
    await runtime.respondToInteraction(request.params);
    return respond({});
  }
  if (request.method === 'cancel') {
    stateChannel?.close();
    modelChannel?.setEnabled(false);
    await runtime.cancel({
      runId: request.params.runId,
      ...(request.params.reason === undefined ? {} : { reason: request.params.reason }),
    });
    return respond({});
  }
  if (request.method === 'shutdown') {
    await stop();
    await respond({});
    process.stdin.destroy();
    return;
  }
  return reject();
}
async function main() {
  let buffer = Buffer.alloc(0);
  for await (const chunk of process.stdin) {
    buffer = Buffer.concat([buffer, Buffer.from(chunk as Uint8Array)]);
    for (;;) {
      const end = buffer.indexOf(10);
      if (end < 0) break;
      if (end > (adapter ? 4 : 32) * 1024 * 1024) throw new Error('Input limit');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, end));
      buffer = buffer.subarray(end + 1);
      await handle(JSON.parse(text));
    }
    if (buffer.length > (adapter ? 4 : 32) * 1024 * 1024) throw new Error('Input limit');
  }
  await stop();
}
process.stdout.on('error', () => process.exit(72));
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void stop().finally(() => process.exit(0));
  });
void main().catch(async () => {
  if (!stopping) process.exitCode = 1;
  await stop();
  process.stdin.destroy();
});

async function restoreSnapshot(value: unknown): Promise<void> {
  if (!Array.isArray(value) || value.length > 2048) throw new Error('Invalid snapshot');
  const root = '/home/sandbox/workspace';
  await mkdir(root, { mode: 0o700 });
  let total = 0;
  const names = new Set<string>();
  for (const file of value) {
    if (
      typeof file !== 'object' ||
      !file ||
      typeof file.path !== 'string' ||
      typeof file.base64 !== 'string' ||
      file.path.length > 1024 ||
      names.has(file.path) ||
      file.path.split('/').length > 17 ||
      file.path.split('/').some((part: string) => !part || part === '.' || part === '..' || /[\\\0]/.test(part)) ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.base64)
    )
      throw new Error('Invalid snapshot file');
    names.add(file.path);
    const bytes = Buffer.from(file.base64, 'base64');
    total += bytes.length;
    if (total > 16 * 1024 * 1024) throw new Error('Snapshot limit');
    const target = path.join(root, file.path);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
  }
}
