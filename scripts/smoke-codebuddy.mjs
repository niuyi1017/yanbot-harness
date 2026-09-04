import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';

import { CodeBuddyAdapter } from '../packages/adapter-codebuddy/dist/index.js';
import { executeAdapterRun } from '../packages/harness-core/dist/index.js';

const apiKey = process.env.CODEBUDDY_API_KEY;
if (!apiKey) {
  console.error('CodeBuddy smoke skipped: missing CODEBUDDY_API_KEY.');
  process.exitCode = 2;
} else {
  await runSmoke(apiKey);
}

async function runSmoke(secret) {
  const workspace = await mkdtemp(path.join(tmpdir(), 'yanbot-harness-codebuddy-'));
  const context = {
    credentials: { CODEBUDDY_API_KEY: secret },
    config: compact({
      internetEnvironment: process.env.CODEBUDDY_INTERNET_ENVIRONMENT,
      baseUrl: process.env.CODEBUDDY_BASE_URL,
      pathToCodebuddyCode: process.env.CODEBUDDY_CODE_PATH,
    }),
  };
  const adapter = new CodeBuddyAdapter();

  try {
    const probe = await adapter.probe(context);
    if (!probe.available) throw new Error(probe.diagnostics?.join('; ') || 'CodeBuddy adapter unavailable.');

    const modelId = process.env.CODEBUDDY_MODEL;
    const first = await collect(
      executeAdapterRun(adapter, context, request('Reply with exactly: yanbot-harness-smoke', workspace, modelId)),
    );
    assertTerminal(first, 'run.completed', 'initial run');
    const adapterSessionId = first.find((event) => event.type === 'session.initialized')?.payload.adapterSessionId;
    if (!adapterSessionId) throw new Error('Initial run did not return an adapter session id.');

    const resumed = await collect(
      executeAdapterRun(
        adapter,
        context,
        request('Reply with exactly: yanbot-harness-resume', workspace, modelId, adapterSessionId),
      ),
    );
    assertTerminal(resumed, 'run.completed', 'resume run');

    const runtime = await adapter.createRuntime(context);
    const abortController = new globalThis.AbortController();
    const cancelled = [];
    try {
      for await (const event of runtime.startRun({
        ...request('Wait briefly, then reply with: yanbot-harness-cancel', workspace, modelId),
        abortSignal: abortController.signal,
      })) {
        cancelled.push(event);
        if (event.type === 'run.started') abortController.abort();
      }
    } finally {
      await runtime.dispose();
    }
    assertTerminal(cancelled, 'run.cancelled', 'cancel run');

    console.log(
      JSON.stringify({
        ok: true,
        sdkVersion: '0.3.43',
        initialEvents: first.map((event) => event.type),
        resumeEvents: resumed.map((event) => event.type),
        cancelEvents: cancelled.map((event) => event.type),
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(redact(message, [secret]));
    process.exitCode = 1;
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

function request(prompt, cwd, modelId, adapterSessionId) {
  return {
    runId: randomUUID(),
    sessionId: randomUUID(),
    prompt,
    cwd,
    permissionPolicy: 'read-only',
    configScopes: [],
    extensions: [],
    ...(modelId ? { model: { adapterId: 'cn.tencent.codebuddy', modelId } } : {}),
    ...(adapterSessionId ? { adapterSessionId } : {}),
  };
}

async function collect(source) {
  const events = [];
  for await (const event of source) events.push(event);
  return events;
}

function assertTerminal(events, expected, label) {
  const terminal = events.at(-1);
  if (terminal?.type !== expected)
    throw new Error(`${label} ended with ${terminal?.type || 'no event'}; expected ${expected}.`);
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item === 'string' && item.length > 0));
}

function redact(message, secrets) {
  return secrets.reduce((safe, secret) => (secret ? safe.split(secret).join('[REDACTED]') : safe), message);
}
