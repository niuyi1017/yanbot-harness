import { describe, expect, it } from 'vitest';

import { runAdapterConformance } from '@yanbot-harness/adapter-kit';
import { createDeterministicClock, createDeterministicIdGenerator } from '@yanbot-harness/testing';

import { ReferenceAdapter } from '../src/index.js';

const request = {
  runId: '11111111-1111-4111-8111-111111111111',
  sessionId: '22222222-2222-4222-8222-222222222222',
  prompt: 'Run the deterministic scenario.',
  permissionPolicy: 'interactive' as const,
  configScopes: [],
  extensions: [],
};

describe('ReferenceAdapter', () => {
  it('passes the common conformance flow without network access', async () => {
    const adapter = new ReferenceAdapter({
      scenario: { kind: 'text', chunks: ['hello', ' world'] },
      now: createDeterministicClock(),
      generateId: createDeterministicIdGenerator(),
    });

    const report = await runAdapterConformance({ adapter, request, forbiddenValues: ['super-secret-value'] });
    expect(report.events.map((event) => event.type)).toEqual([
      'run.started',
      'session.initialized',
      'assistant.delta',
      'assistant.delta',
      'assistant.message',
      'usage.updated',
      'run.completed',
    ]);
  });

  it('supports deterministic cancellation', async () => {
    const adapter = new ReferenceAdapter({
      scenario: { kind: 'wait-for-cancel' },
      now: createDeterministicClock(),
      generateId: createDeterministicIdGenerator(),
    });

    const report = await runAdapterConformance({ adapter, request, cancelAfterEvents: 2 });
    expect(report.events.at(-1)?.type).toBe('run.cancelled');
  });

  it.each([
    {
      scenario: { kind: 'tool', toolName: 'Read', result: { files: 2 } } as const,
      expected: ['run.started', 'session.initialized', 'tool.started', 'tool.completed', 'run.completed'],
    },
    {
      scenario: { kind: 'failure', code: 'HARNESS_FAILED' } as const,
      expected: ['run.started', 'session.initialized', 'run.failed'],
    },
  ])('emits a valid terminal stream for the $scenario.kind scenario', async ({ scenario, expected }) => {
    const adapter = new ReferenceAdapter({
      scenario,
      now: createDeterministicClock(),
      generateId: createDeterministicIdGenerator(),
    });

    const report = await runAdapterConformance({ adapter, request });
    expect(report.events.map((event) => event.type)).toEqual(expected);
  });

  it('round-trips permission interactions', async () => {
    const adapter = new ReferenceAdapter({
      scenario: { kind: 'permission', toolName: 'Write', allowResult: 'approved' },
      now: createDeterministicClock(),
      generateId: createDeterministicIdGenerator(),
    });
    const runtime = await adapter.createRuntime({});
    const iterator = runtime.startRun(request)[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.next();
    const requested = await iterator.next();
    expect(requested.value?.type).toBe('interaction.requested');
    const requestId = requested.value?.type === 'interaction.requested' ? requested.value.payload.requestId : '';

    await runtime.respondToInteraction?.({ requestId, action: 'allow' });
    const remaining = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      remaining.push(next.value.type);
    }
    expect(remaining).toEqual(['interaction.resolved', 'assistant.message', 'run.completed']);
    await runtime.dispose();
  });

  it('round-trips question interactions', async () => {
    const adapter = new ReferenceAdapter({
      scenario: { kind: 'question', prompt: 'Continue?', answerResult: 'continued' },
      now: createDeterministicClock(),
      generateId: createDeterministicIdGenerator(),
    });
    const runtime = await adapter.createRuntime({});
    const iterator = runtime.startRun(request)[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.next();
    const requested = await iterator.next();
    expect(requested.value?.type).toBe('interaction.requested');
    if (requested.value?.type !== 'interaction.requested' || requested.value.payload.kind !== 'question') {
      throw new Error('Expected a question interaction.');
    }
    const questionId = requested.value.payload.questions[0]?.id;
    if (!questionId) throw new Error('Expected a question id.');

    await runtime.respondToInteraction?.({
      requestId: requested.value.payload.requestId,
      action: 'submit',
      answers: { [questionId]: 'yes' },
    });
    const remaining = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      remaining.push(next.value.type);
    }
    expect(remaining).toEqual(['interaction.resolved', 'assistant.message', 'run.completed']);
    await runtime.dispose();
  });
});
