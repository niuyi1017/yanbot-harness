import { describe, expect, it, vi } from 'vitest';

import { HARNESS_PROTOCOL_VERSION, type AdapterEvent, type RunRequest } from '@yanbot-harness/contracts';
import type { AdapterRuntime, HarnessAdapter } from '@yanbot-harness/adapter-api';

import { createManagedAdapterRun, executeAdapterRun } from '../src/index.js';

const request: RunRequest = {
  runId: '11111111-1111-4111-8111-111111111111',
  sessionId: '22222222-2222-4222-8222-222222222222',
  prompt: 'Run the deterministic test.',
  permissionPolicy: 'interactive',
  configScopes: [],
  extensions: [],
};

function event(sequence: number, type: 'run.started' | 'run.completed'): AdapterEvent {
  const base = {
    protocolVersion: HARNESS_PROTOCOL_VERSION,
    eventId: `${sequence}3333333-3333-4333-8333-333333333333`,
    runId: request.runId,
    sessionId: request.sessionId,
    sequence,
    timestamp: '2026-01-01T00:00:00.000Z',
  };
  return type === 'run.started'
    ? { ...base, type, payload: { adapterId: 'cn.yanbot.test' } }
    : { ...base, type, payload: {} };
}

function createAdapter(events: readonly AdapterEvent[]) {
  const dispose = vi.fn(async () => {});
  const runtime: AdapterRuntime = {
    async capabilities() {
      return {};
    },
    async *startRun() {
      yield* events;
    },
    async cancel() {},
    dispose,
  };
  const adapter: HarnessAdapter = {
    manifest: {
      protocolVersion: HARNESS_PROTOCOL_VERSION,
      adapterId: 'cn.yanbot.test',
      adapterVersion: '0.1.0',
      displayName: 'Test Adapter',
      harness: { name: 'Test Harness' },
      runtimeKinds: ['in-process'],
    },
    async probe() {
      return { available: true };
    },
    async createRuntime() {
      return runtime;
    },
  };
  return { adapter, dispose };
}

async function collect(adapter: HarnessAdapter, runRequest: RunRequest = request): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  for await (const candidate of executeAdapterRun(adapter, {}, runRequest)) events.push(candidate);
  return events;
}

describe('executeAdapterRun', () => {
  it('validates and returns a complete event stream', async () => {
    const { adapter, dispose } = createAdapter([event(1, 'run.started'), event(2, 'run.completed')]);

    await expect(collect(adapter)).resolves.toMatchObject([
      { sequence: 1, type: 'run.started' },
      { sequence: 2, type: 'run.completed' },
    ]);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('rejects an invalid sequence and still disposes the runtime', async () => {
    const { adapter, dispose } = createAdapter([event(1, 'run.started'), event(3, 'run.completed')]);

    await expect(collect(adapter)).rejects.toMatchObject({ code: 'HARNESS_PROTOCOL_ERROR' });
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('rejects a stream without a terminal event', async () => {
    const { adapter, dispose } = createAdapter([event(1, 'run.started')]);

    await expect(collect(adapter)).rejects.toMatchObject({ code: 'HARNESS_PROTOCOL_ERROR' });
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('returns a stable error when resume is unavailable', async () => {
    const { adapter, dispose } = createAdapter([]);

    await expect(collect(adapter, { ...request, adapterSessionId: 'existing-session' })).rejects.toMatchObject({
      code: 'CAPABILITY_UNSUPPORTED',
    });
    expect(dispose).toHaveBeenCalledOnce();
  });
});

describe('createManagedAdapterRun', () => {
  it('responds to a pending interaction and treats an identical retry idempotently', async () => {
    let resolveResponse: (() => void) | undefined;
    const responseReceived = new Promise<void>((resolve) => {
      resolveResponse = resolve;
    });
    const respondToInteraction = vi.fn(async () => resolveResponse?.());
    const dispose = vi.fn(async () => {});
    const runtime: AdapterRuntime = {
      async capabilities() {
        return { 'interactions.permissions': { level: 'native' } };
      },
      async *startRun() {
        yield event(1, 'run.started');
        yield {
          protocolVersion: HARNESS_PROTOCOL_VERSION,
          eventId: '43333333-3333-4333-8333-333333333333',
          runId: request.runId,
          sessionId: request.sessionId,
          sequence: 2,
          timestamp: '2026-01-01T00:00:00.000Z',
          type: 'interaction.requested',
          payload: { kind: 'permission', requestId: 'permission-1', toolName: 'Write', risk: 'high' },
        } satisfies AdapterEvent;
        await responseReceived;
        yield {
          protocolVersion: HARNESS_PROTOCOL_VERSION,
          eventId: '53333333-3333-4333-8333-333333333333',
          runId: request.runId,
          sessionId: request.sessionId,
          sequence: 3,
          timestamp: '2026-01-01T00:00:00.000Z',
          type: 'interaction.resolved',
          payload: { requestId: 'permission-1', outcome: 'allowed' },
        } satisfies AdapterEvent;
        yield event(4, 'run.completed');
      },
      respondToInteraction,
      async cancel() {},
      dispose,
    };
    const controller = await createManagedAdapterRun(adapterFor(runtime), {}, request);
    const iterator = controller.events[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'run.started' } });
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'interaction.requested' } });
    const response = { requestId: 'permission-1', action: 'allow' as const };
    await controller.respond(response);
    await controller.respond(response);
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'interaction.resolved' } });
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'run.completed' } });
    await expect(iterator.next()).resolves.toMatchObject({ done: true });

    expect(respondToInteraction).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('rejects responses before registration and conflicting retries', async () => {
    let resolveResponse: (() => void) | undefined;
    const responseReceived = new Promise<void>((resolve) => {
      resolveResponse = resolve;
    });
    const runtime: AdapterRuntime = {
      async capabilities() {
        return { 'interactions.permissions': { level: 'native' } };
      },
      async *startRun() {
        yield event(1, 'run.started');
        yield {
          protocolVersion: HARNESS_PROTOCOL_VERSION,
          eventId: '43333333-3333-4333-8333-333333333333',
          runId: request.runId,
          sessionId: request.sessionId,
          sequence: 2,
          timestamp: '2026-01-01T00:00:00.000Z',
          type: 'interaction.requested',
          payload: { kind: 'permission', requestId: 'permission-1', toolName: 'Write', risk: 'high' },
        } satisfies AdapterEvent;
        await responseReceived;
        yield {
          protocolVersion: HARNESS_PROTOCOL_VERSION,
          eventId: '53333333-3333-4333-8333-333333333333',
          runId: request.runId,
          sessionId: request.sessionId,
          sequence: 3,
          timestamp: '2026-01-01T00:00:00.000Z',
          type: 'interaction.resolved',
          payload: { requestId: 'permission-1', outcome: 'allowed' },
        } satisfies AdapterEvent;
        yield event(4, 'run.completed');
      },
      async respondToInteraction() {
        resolveResponse?.();
      },
      async cancel() {},
      async dispose() {},
    };
    const controller = await createManagedAdapterRun(adapterFor(runtime), {}, request);
    await expect(controller.respond({ requestId: 'permission-1', action: 'allow' })).rejects.toMatchObject({
      code: 'INTERACTION_EXPIRED',
    });
    const iterator = controller.events[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.next();
    await controller.respond({ requestId: 'permission-1', action: 'allow' });
    await expect(controller.respond({ requestId: 'permission-1', action: 'deny' })).rejects.toMatchObject({
      code: 'INTERACTION_EXPIRED',
    });
    await iterator.next();
    await iterator.next();
    await iterator.next();
  });

  it('cancels and disposes a managed run idempotently', async () => {
    let release: (() => void) | undefined;
    const cancelled = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cancel = vi.fn(async () => release?.());
    const dispose = vi.fn(async () => {});
    const runtime: AdapterRuntime = {
      async capabilities() {
        return {};
      },
      async *startRun() {
        yield event(1, 'run.started');
        await cancelled;
        yield {
          protocolVersion: HARNESS_PROTOCOL_VERSION,
          eventId: '43333333-3333-4333-8333-333333333333',
          runId: request.runId,
          sessionId: request.sessionId,
          sequence: 2,
          timestamp: '2026-01-01T00:00:00.000Z',
          type: 'run.cancelled',
          payload: { reason: 'test' },
        } satisfies AdapterEvent;
      },
      cancel,
      dispose,
    };
    const controller = await createManagedAdapterRun(adapterFor(runtime), {}, request);
    const iterator = controller.events[Symbol.asyncIterator]();
    await iterator.next();
    await controller.cancel('test');
    await controller.cancel('test');
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'run.cancelled' } });
    await iterator.next();
    await controller.dispose();

    expect(cancel).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });
});

function adapterFor(runtime: AdapterRuntime): HarnessAdapter {
  return {
    manifest: {
      protocolVersion: HARNESS_PROTOCOL_VERSION,
      adapterId: 'cn.yanbot.test',
      adapterVersion: '0.1.0',
      displayName: 'Test Adapter',
      harness: { name: 'Test Harness' },
      runtimeKinds: ['in-process'],
    },
    async probe() {
      return { available: true };
    },
    async createRuntime() {
      return runtime;
    },
  };
}
