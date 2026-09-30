import { TextDecoder } from 'node:util';
import { sidecarRequestSchema, type SidecarRequest } from '@yanbot-harness/adapter-sidecar';
import { HARNESS_PROTOCOL_VERSION } from '@yanbot-harness/contracts';
import { executeClaudeRun, probeClaude, type ClaudeDeployment } from './execute.js';
import { capabilities, CLAUDE_CODE_VERSION, manifest } from './manifest.js';

const deployment: ClaudeDeployment = {
  executablePath: process.env.HARNESS_CLAUDE_EXECUTABLE ?? '',
  ...(process.env.ANTHROPIC_API_KEY ? { apiKey: process.env.ANTHROPIC_API_KEY } : {}),
  ...(process.env.HARNESS_CLI_JOB_HOST ? { windowsJobHost: process.env.HARNESS_CLI_JOB_HOST } : {}),
};
let initialized = false;
let stopping = false;
let active: { runId: string; controller: AbortController; done: Promise<void> } | undefined;

async function write(frame: unknown): Promise<void> {
  const value = JSON.stringify(frame, (_key, item: unknown) =>
    typeof item === 'string' && deployment.apiKey ? item.replaceAll(deployment.apiKey, '[redacted]') : item,
  );
  await new Promise<void>((resolve, reject) =>
    process.stdout.write(`${value}\n`, (error) => (error ? reject(error) : resolve())),
  );
}
async function handle(request: SidecarRequest): Promise<void> {
  const respond = (result: unknown) => write({ jsonrpc: '2.0', id: request.id, result });
  const reject = () =>
    write({ jsonrpc: '2.0', id: request.id, error: { code: -32602, message: 'Unsupported Sidecar request.' } });
  if (stopping) return reject();
  if (request.method === 'initialize') {
    if (initialized || request.params.protocolVersion !== HARNESS_PROTOCOL_VERSION) return reject();
    initialized = true;
    return respond({ protocolVersion: HARNESS_PROTOCOL_VERSION, manifest, capabilities });
  }
  if (!initialized) return reject();
  if (request.method === 'capabilities') return respond(capabilities);
  if (request.method === 'probe') {
    const available = await probeClaude(deployment).catch(() => false);
    return respond({
      available,
      ...(available
        ? { harnessVersion: CLAUDE_CODE_VERSION }
        : { diagnostics: ['Supported Claude Code executable unavailable.'] }),
    });
  }
  if (request.method === 'startRun') {
    if (active) return reject();
    const controller = new AbortController();
    await respond({});
    const done = executeClaudeRun(deployment, request.params, controller.signal, (event) =>
      write({ jsonrpc: '2.0', method: 'event', params: event }),
    );
    active = { runId: request.params.runId, controller, done };
    void done
      .catch(() => {
        process.exitCode = 1;
        void stop().finally(() => process.stdin.destroy());
      })
      .finally(() => {
        active = undefined;
      });
    return;
  }
  if (request.method === 'cancel') {
    if (active?.runId === request.params.runId) active.controller.abort();
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
async function stop(): Promise<void> {
  stopping = true;
  active?.controller.abort();
  await active?.done.catch(() => undefined);
}
async function main(): Promise<void> {
  let buffer = Buffer.alloc(0);
  for await (const chunk of process.stdin) {
    buffer = Buffer.concat([buffer, Buffer.from(chunk as Uint8Array)]);
    for (;;) {
      const end = buffer.indexOf(10);
      if (end < 0) break;
      if (end > 4 * 1024 * 1024) throw new Error('Request limit');
      const line = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, end));
      buffer = buffer.subarray(end + 1);
      await handle(sidecarRequestSchema.parse(JSON.parse(line)));
    }
    if (buffer.length > 4 * 1024 * 1024) throw new Error('Request limit');
  }
  await stop();
}
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.once(signal, () => {
    void stop().finally(() => process.stdin.destroy());
  });
process.stdout.on('error', () => {
  void stop().finally(() => process.stdin.destroy());
});
void main().catch(async () => {
  if (!stopping) process.exitCode = 1;
  await stop();
  process.stdin.destroy();
});
