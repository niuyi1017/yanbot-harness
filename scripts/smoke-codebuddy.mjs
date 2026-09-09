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
  const smokeTimeoutMs = positiveInteger(process.env.YANBOT_HARNESS_SMOKE_TIMEOUT_MS, 5 * 60 * 1_000);
  const smokeAbortController = new globalThis.AbortController();
  let deadlineExceeded = false;
  const softDeadline = globalThis.setTimeout(() => {
    deadlineExceeded = true;
    smokeAbortController.abort(new Error(`CodeBuddy smoke exceeded ${smokeTimeoutMs}ms.`));
  }, smokeTimeoutMs);
  const hardDeadline = globalThis.setTimeout(() => {
    console.error(`CodeBuddy smoke cleanup exceeded ${smokeTimeoutMs + 10_000}ms; forcing failure exit.`);
    process.exit(1);
  }, smokeTimeoutMs + 10_000);
  try {
    await runSmoke(apiKey, smokeAbortController.signal);
    if (deadlineExceeded) process.exitCode = 1;
  } finally {
    globalThis.clearTimeout(softDeadline);
    globalThis.clearTimeout(hardDeadline);
  }
  if (process.env.YANBOT_HARNESS_SMOKE_DEBUG_HANDLES === '1') {
    await new Promise((resolve) => globalThis.setTimeout(resolve, 100));
    reportActiveResources();
  }
}

async function runSmoke(secret, smokeAbortSignal) {
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
      executeAdapterRun(
        adapter,
        context,
        request('Reply with exactly: yanbot-harness-smoke', workspace, modelId, undefined, smokeAbortSignal),
      ),
    );
    assertTerminal(first, 'run.completed', 'initial run');
    const adapterSessionId = first.find((event) => event.type === 'session.initialized')?.payload.adapterSessionId;
    if (!adapterSessionId) throw new Error('Initial run did not return an adapter session id.');

    const resumed = await collect(
      executeAdapterRun(
        adapter,
        context,
        request('Reply with exactly: yanbot-harness-resume', workspace, modelId, adapterSessionId, smokeAbortSignal),
      ),
    );
    assertTerminal(resumed, 'run.completed', 'resume run');

    const usage = first.find((event) => event.type === 'usage.updated')?.payload ?? {};

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

    if (!(await waitForNoActiveChildProcesses(5_000))) {
      throw new Error('CodeBuddy smoke completed but a vendor child process remained active after 5000ms.');
    }

    console.log(
      JSON.stringify({
        ok: true,
        sdkVersion: '0.3.254',
        tokenUsageObserved:
          typeof usage.inputTokens === 'number' ||
          typeof usage.outputTokens === 'number' ||
          typeof usage.cachedInputTokens === 'number',
        costUsageObserved: typeof usage.costUsd === 'number',
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

function request(prompt, cwd, modelId, adapterSessionId, abortSignal) {
  return {
    runId: randomUUID(),
    sessionId: randomUUID(),
    prompt,
    cwd,
    permissionPolicy: 'read-only',
    configScopes: [],
    extensions: [],
    ...(abortSignal ? { abortSignal } : {}),
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
  if (terminal?.type !== expected) {
    const failure = terminal?.type === 'run.failed' ? terminal.payload.error : undefined;
    const detail = failure ? ` (${failure.code}: ${failure.message})` : '';
    throw new Error(`${label} ended with ${terminal?.type || 'no event'}; expected ${expected}.${detail}`);
  }
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item === 'string' && item.length > 0));
}

function positiveInteger(value, fallback) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function redact(message, secrets) {
  return secrets.reduce((safe, secret) => (secret ? safe.split(secret).join('[REDACTED]') : safe), message);
}

function reportActiveResources() {
  const getActiveHandles = process._getActiveHandles;
  const getActiveRequests = process._getActiveRequests;
  const handles = typeof getActiveHandles === 'function' ? getActiveHandles.call(process) : [];
  const requests = typeof getActiveRequests === 'function' ? getActiveRequests.call(process) : [];
  console.error(
    JSON.stringify({
      activeHandleTypes: handles.map((handle) => handle?.constructor?.name ?? 'unknown').sort(),
      activeChildProcesses: handles
        .filter((handle) => handle?.constructor?.name === 'ChildProcess')
        .map((handle) => ({
          pid: handle.pid,
          spawnfile: handle.spawnfile,
          killed: handle.killed,
          exitCode: handle.exitCode,
          signalCode: handle.signalCode,
          connected: handle.connected,
        })),
      activeRequestTypes: requests.map((request) => request?.constructor?.name ?? 'unknown').sort(),
    }),
  );
}

async function waitForNoActiveChildProcesses(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (activeChildProcesses().length === 0) return true;
    await new Promise((resolve) => globalThis.setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  return activeChildProcesses().length === 0;
}

function activeChildProcesses() {
  const getActiveHandles = process._getActiveHandles;
  const handles = typeof getActiveHandles === 'function' ? getActiveHandles.call(process) : [];
  return handles.filter((handle) => handle?.constructor?.name === 'ChildProcess');
}
