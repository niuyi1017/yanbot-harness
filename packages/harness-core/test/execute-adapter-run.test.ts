import { describe, expect, it, vi } from 'vitest';

import { HARNESS_PROTOCOL_VERSION, type AdapterEvent, type RunRequest } from '@yanbot-harness/contracts';
import type { AdapterRuntime, HarnessAdapter } from '@yanbot-harness/adapter-api';

import { executeAdapterRun } from '../src/index.js';

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
