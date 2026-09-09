import { readFile } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import { runAdapterConformance } from '@yanbot-harness/adapter-kit';
import { createDeterministicClock, createDeterministicIdGenerator } from '@yanbot-harness/testing';

import {
  CodeBuddyAdapter,
  type CodeBuddyAdapterOptions,
  type CodeBuddyPermissionResult,
  type CodeBuddyQueryInput,
  type CodeBuddyQueryStream,
  type CodeBuddySdkFacade,
} from '../src/index.js';

const request = {
  runId: '11111111-1111-4111-8111-111111111111',
  sessionId: '22222222-2222-4222-8222-222222222222',
  prompt: 'Run the CodeBuddy fixture.',
  model: { adapterId: 'cn.tencent.codebuddy', modelId: 'fixture-model' },
  permissionPolicy: 'interactive' as const,
  configScopes: ['organization', 'project'] as const,
  extensions: [],
};
const context = {
  credentials: { CODEBUDDY_API_KEY: 'fixture-secret' },
  config: { internetEnvironment: 'external', baseUrl: 'https://fixture.invalid/' },
};

async function fixture(name: string): Promise<unknown[]> {
  const url = new URL(`../../testing/fixtures/codebuddy/${name}.json`, import.meta.url);
  return JSON.parse(await readFile(url, 'utf8')) as unknown[];
}

function streamFrom(messages: readonly unknown[], onInterrupt = () => {}): CodeBuddyQueryStream {
  return {
    async *[Symbol.asyncIterator]() {
      yield* messages;
    },
    async interrupt() {
      onInterrupt();
    },
  };
}

function facadeWith(messages: readonly unknown[]) {
  let lastInput: CodeBuddyQueryInput | undefined;
  const sdk: CodeBuddySdkFacade = {
    query(input) {
      lastInput = input;
      return streamFrom(messages);
    },
    async listModels() {
      return [{ modelId: 'fixture-model', name: 'Fixture Model', description: 'Offline fixture' }];
    },
  };
  return { sdk, getLastInput: () => lastInput };
}

function adapter(sdk: CodeBuddySdkFacade, options: Omit<CodeBuddyAdapterOptions, 'sdk'> = {}): CodeBuddyAdapter {
  return new CodeBuddyAdapter({
    sdk,
    now: createDeterministicClock(),
    generateId: createDeterministicIdGenerator(),
    ...options,
  });
}

describe('CodeBuddyAdapter', () => {
  it('reports missing credentials without exposing values', async () => {
    await expect(new CodeBuddyAdapter().probe({})).resolves.toEqual({
      available: false,
      harnessVersion: '0.3.254',
      diagnostics: ['Missing credential: CODEBUDDY_API_KEY'],
    });
  });

  it('normalizes the success fixture and keeps vendor options inside the adapter', async () => {
    const fake = facadeWith(await fixture('success'));
    const report = await runAdapterConformance({
      adapter: adapter(fake.sdk),
      request,
      context,
      forbiddenValues: ['fixture-secret', '/Users/example'],
    });

    expect(report.events.map((event) => event.type)).toEqual([
      'run.started',
      'session.initialized',
      'assistant.delta',
      'assistant.delta',
      'assistant.message',
      'tool.started',
      'tool.completed',
      'usage.updated',
      'run.completed',
    ]);
    expect(fake.getLastInput()).toMatchObject({
      model: 'fixture-model',
      permissionMode: 'default',
      settingSources: ['project'],
      env: {
        CODEBUDDY_API_KEY: 'fixture-secret',
        CODEBUDDY_INTERNET_ENVIRONMENT: 'external',
        CODEBUDDY_BASE_URL: 'https://fixture.invalid',
      },
    });
  });

  it('releases the vendor stream after a successful result', async () => {
    const interrupt = vi.fn(async () => undefined);
    const closeStream = vi.fn(async () => ({ value: undefined, done: true }) as IteratorResult<unknown, void>);
    const sdk: CodeBuddySdkFacade = {
      query() {
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'system', subtype: 'init', session_id: 'cleanup-session' };
            yield { type: 'result', subtype: 'success', is_error: false, session_id: 'cleanup-session' };
          },
          interrupt,
          return: closeStream,
        };
      },
      async listModels() {
        return [];
      },
    };

    const report = await runAdapterConformance({ adapter: adapter(sdk), request, context });

    expect(report.events.at(-1)?.type).toBe('run.completed');
    expect(interrupt).toHaveBeenCalledOnce();
    expect(closeStream).toHaveBeenCalledOnce();
  });

  it('does not repeat vendor cleanup when runtime disposal follows completion', async () => {
    const interrupt = vi.fn(async () => undefined);
    const closeStream = vi.fn(async () => ({ value: undefined, done: true }) as IteratorResult<unknown, void>);
    const sdk: CodeBuddySdkFacade = {
      query() {
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'system', subtype: 'init', session_id: 'idempotent-cleanup-session' };
            yield { type: 'result', subtype: 'success', is_error: false };
          },
          interrupt,
          return: closeStream,
        };
      },
      async listModels() {
        return [];
      },
    };
    const runtime = await adapter(sdk).createRuntime(context);

    const events = [];
    for await (const event of runtime.startRun(request)) events.push(event);
    await runtime.dispose();
    await runtime.dispose();

    expect(events.at(-1)?.type).toBe('run.completed');
    expect(interrupt).toHaveBeenCalledOnce();
    expect(closeStream).toHaveBeenCalledOnce();
  });

  it('normalizes a top-level tool result exactly once', async () => {
    const fake = facadeWith(await fixture('top-level-tool-result'));
    const report = await runAdapterConformance({ adapter: adapter(fake.sdk), request, context });
    expect(report.events.filter((event) => event.type === 'tool.started')).toHaveLength(1);
    expect(report.events.filter((event) => event.type === 'tool.completed')).toHaveLength(1);
  });

  it('turns a missing result message into a protocol failure', async () => {
    const fake = facadeWith(await fixture('no-result'));
    const report = await runAdapterConformance({ adapter: adapter(fake.sdk), request, context });
    expect(report.events.at(-1)).toMatchObject({
      type: 'run.failed',
      payload: { error: { code: 'HARNESS_PROTOCOL_ERROR' } },
    });
  });

  it('turns a legacy assistant-form 401 into an authentication failure', async () => {
    const interrupt = vi.fn(async () => undefined);
    const sdk: CodeBuddySdkFacade = {
      query() {
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'system', subtype: 'init', session_id: 'unauthorized-session' };
            yield {
              type: 'assistant',
              message: { content: [{ type: 'text', text: '401 Unauthorized' }] },
            };
            yield {
              type: 'assistant',
              message: {
                content: [{ type: 'text', text: 'Request completed unexpectedly. Please try again.' }],
              },
            };
            await new Promise<void>(() => undefined);
          },
          interrupt,
        };
      },
      async listModels() {
        return [];
      },
    };
    const report = await runAdapterConformance({
      adapter: adapter(sdk, { terminalSignalGraceMs: 20, shutdownGraceMs: 10 }),
      request,
      context,
    });

    expect(report.events.at(-1)).toMatchObject({
      type: 'run.failed',
      payload: { error: { code: 'AUTHENTICATION_FAILED', message: '401 Unauthorized' } },
    });
    expect(report.events.some((event) => event.type === 'assistant.message')).toBe(false);
    expect(interrupt).toHaveBeenCalledOnce();
  });

  it('fails an idle vendor stream without waiting indefinitely', async () => {
    const interrupt = vi.fn(() => new Promise<void>(() => undefined));
    const sdk: CodeBuddySdkFacade = {
      query() {
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'system', subtype: 'init', session_id: 'idle-session' };
            await new Promise<void>(() => undefined);
          },
          interrupt,
        };
      },
      async listModels() {
        return [];
      },
    };
    const report = await runAdapterConformance({
      adapter: adapter(sdk, { idleTimeoutMs: 20, runTimeoutMs: 1_000, shutdownGraceMs: 10 }),
      request,
      context,
    });

    expect(report.events.at(-1)).toMatchObject({
      type: 'run.failed',
      payload: { error: { code: 'RUN_TIMEOUT', adapterCode: 'CODEBUDDY_IDLE_TIMEOUT' } },
    });
    expect(interrupt).toHaveBeenCalledOnce();
  });

  it('applies the wall-clock deadline independently of idle activity', async () => {
    let permissionResult: CodeBuddyPermissionResult | undefined;
    const sdk: CodeBuddySdkFacade = {
      query(input) {
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'system', subtype: 'init', session_id: 'wall-session' };
            permissionResult = await input.canUseTool(
              'Write',
              { path: 'pending.txt' },
              { toolUseID: 'pending-until-wall-timeout' },
            );
          },
          async interrupt() {},
        };
      },
      async listModels() {
        return [];
      },
    };
    const report = await runAdapterConformance({
      adapter: adapter(sdk, { idleTimeoutMs: 5, runTimeoutMs: 30, shutdownGraceMs: 10 }),
      request,
      context,
    });

    expect(report.events.at(-1)).toMatchObject({
      type: 'run.failed',
      payload: { error: { code: 'RUN_TIMEOUT', adapterCode: 'CODEBUDDY_RUN_TIMEOUT' } },
    });
    expect(permissionResult).toEqual({ behavior: 'deny', message: 'Run timed out.' });
  });

  it('maps resume, permission responses, and permission policy', async () => {
    let permissionResult: CodeBuddyPermissionResult | undefined;
    let queryInput: CodeBuddyQueryInput | undefined;
    const sdk: CodeBuddySdkFacade = {
      query(input) {
        queryInput = input;
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'system', subtype: 'init', session_id: 'resumed-session' };
            permissionResult = await input.canUseTool('Write', { path: 'fixture.txt' }, { toolUseID: 'permission-1' });
            yield { type: 'result', subtype: 'success', is_error: false, session_id: 'resumed-session' };
          },
          async interrupt() {},
        };
      },
      async listModels() {
        return [];
      },
    };
    const runtime = await adapter(sdk).createRuntime(context);
    const iterator = runtime.resumeRun({ ...request, adapterSessionId: 'existing-session' })[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.next();
    const interaction = await iterator.next();
    expect(interaction.value).toMatchObject({ type: 'interaction.requested', payload: { requestId: 'permission-1' } });
    await runtime.respondToInteraction?.({ requestId: 'permission-1', action: 'allow' });
    while (!(await iterator.next()).done) {
      // Drain the terminal stream.
    }

    expect(permissionResult).toEqual({ behavior: 'allow', updatedInput: { path: 'fixture.txt' } });
    expect(queryInput).toMatchObject({ resume: 'existing-session', permissionMode: 'default' });
    await runtime.dispose();
  });

  it.each([
    { policy: 'auto-edit' as const, expectedMode: 'acceptEdits' },
    { policy: 'read-only' as const, expectedMode: 'plan' },
  ])('maps the $policy policy to $expectedMode', async ({ policy, expectedMode }) => {
    let queryInput: CodeBuddyQueryInput | undefined;
    let toolResult: CodeBuddyPermissionResult | undefined;
    const sdk: CodeBuddySdkFacade = {
      query(input) {
        queryInput = input;
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'system', subtype: 'init', session_id: 'policy-session' };
            if (policy === 'read-only') {
              toolResult = await input.canUseTool('Bash', { command: 'pwd' }, { toolUseID: 'policy-tool' });
            }
            yield { type: 'result', subtype: 'success', is_error: false, session_id: 'policy-session' };
          },
          async interrupt() {},
        };
      },
      async listModels() {
        return [];
      },
    };
    await runAdapterConformance({ adapter: adapter(sdk), request: { ...request, permissionPolicy: policy }, context });
    expect(queryInput?.permissionMode).toBe(expectedMode);
    if (policy === 'read-only') {
      expect(toolResult).toEqual({ behavior: 'deny', message: 'The read-only policy denies tool execution.' });
    }
  });

  it('maps question answers back to the vendor question text', async () => {
    let permissionResult: CodeBuddyPermissionResult | undefined;
    const sdk: CodeBuddySdkFacade = {
      query(input) {
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'system', subtype: 'init', session_id: 'question-session' };
            permissionResult = await input.canUseTool(
              'AskUserQuestion',
              { questions: [{ question: 'Continue?', options: [{ label: 'Yes' }], multiSelect: false }] },
              { toolUseID: 'question-1' },
            );
            yield { type: 'result', subtype: 'success', is_error: false, session_id: 'question-session' };
          },
          async interrupt() {},
        };
      },
      async listModels() {
        return [];
      },
    };
    const runtime = await adapter(sdk).createRuntime(context);
    const iterator = runtime.startRun(request)[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.next();
    const interaction = await iterator.next();
    if (interaction.value?.type !== 'interaction.requested' || interaction.value.payload.kind !== 'question') {
      throw new Error('Expected a question interaction.');
    }
    const questionId = interaction.value.payload.questions[0]?.id;
    if (!questionId) throw new Error('Expected a question id.');
    await runtime.respondToInteraction?.({
      requestId: interaction.value.payload.requestId,
      action: 'submit',
      answers: { [questionId]: 'Yes' },
    });
    while (!(await iterator.next()).done) {
      // Drain the terminal stream.
    }

    expect(permissionResult).toEqual({
      behavior: 'allow',
      updatedInput: {
        questions: [{ question: 'Continue?', options: [{ label: 'Yes' }], multiSelect: false }],
        answers: { 'Continue?': 'Yes' },
      },
    });
    await runtime.dispose();
  });

  it('interrupts and emits a cancellation terminal event', async () => {
    let release: (() => void) | undefined;
    const interrupted = new Promise<void>((resolve) => {
      release = resolve;
    });
    const interrupt = vi.fn(async () => release?.());
    const sdk: CodeBuddySdkFacade = {
      query() {
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'system', subtype: 'init', session_id: 'cancel-session' };
            await interrupted;
          },
          interrupt,
        };
      },
      async listModels() {
        return [];
      },
    };
    const report = await runAdapterConformance({
      adapter: adapter(sdk),
      request,
      context,
      cancelAfterEvents: 2,
    });
    expect(report.events.at(-1)?.type).toBe('run.cancelled');
    expect(interrupt).toHaveBeenCalledOnce();
  });

  it('does not let a non-responsive interrupt block cancellation', async () => {
    const interrupt = vi.fn(() => new Promise<void>(() => undefined));
    const closeStream = vi.fn(async () => ({ value: undefined, done: true }) as IteratorResult<unknown, void>);
    const sdk: CodeBuddySdkFacade = {
      query() {
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'system', subtype: 'init', session_id: 'stuck-cancel-session' };
            await new Promise<void>(() => undefined);
          },
          interrupt,
          return: closeStream,
        };
      },
      async listModels() {
        return [];
      },
    };
    const report = await runAdapterConformance({
      adapter: adapter(sdk, { shutdownGraceMs: 10 }),
      request,
      context,
      cancelAfterEvents: 2,
    });

    expect(report.events.filter((event) => event.type === 'run.cancelled')).toHaveLength(1);
    expect(report.events.at(-1)?.type).toBe('run.cancelled');
    expect(interrupt).toHaveBeenCalledOnce();
    expect(closeStream).toHaveBeenCalledOnce();
  });

  it('does not expose model discovery while the vendor subprocess cannot be released', async () => {
    const fake = facadeWith([]);
    const runtime = await adapter(fake.sdk).createRuntime(context);
    await expect(runtime.capabilities()).resolves.toMatchObject({
      'models.list': { level: 'unsupported' },
    });
    expect(runtime.listModels).toBeUndefined();
    await runtime.dispose();
  });

  it('redacts credentials when classifying SDK errors', async () => {
    const sdk: CodeBuddySdkFacade = {
      query() {
        return {
          async *[Symbol.asyncIterator]() {
            yield* [];
            throw new Error('401 invalid API key fixture-secret');
          },
          async interrupt() {},
        };
      },
      async listModels() {
        return [];
      },
    };
    const report = await runAdapterConformance({ adapter: adapter(sdk), request, context });
    expect(report.events.at(-1)).toMatchObject({
      type: 'run.failed',
      payload: { error: { code: 'AUTHENTICATION_FAILED', message: '401 invalid API key [REDACTED]' } },
    });
    expect(JSON.stringify(report.events)).not.toContain('fixture-secret');
  });
});
