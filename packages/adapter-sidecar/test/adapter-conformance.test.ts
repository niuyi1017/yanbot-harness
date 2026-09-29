import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { runAdapterConformance } from '@yanbot-harness/adapter-kit';
import { describe, expect, it } from 'vitest';

import { SidecarAdapter } from '../src/index.js';

const fixture = fileURLToPath(new URL('./fixtures/reference-sidecar.mjs', import.meta.url));
const manifest = {
  protocolVersion: '1.0.0' as const,
  adapterId: 'cn.yanbot.sidecar-reference',
  adapterVersion: '0.1.0',
  displayName: 'Sidecar Reference Fixture',
  harness: { name: 'Sidecar Reference Fixture' },
  runtimeKinds: ['sidecar' as const],
};
const request = {
  runId: '11111111-1111-4111-8111-111111111111',
  sessionId: '22222222-2222-4222-8222-222222222222',
  prompt: 'Run the Reference Sidecar.',
  permissionPolicy: 'interactive' as const,
  configScopes: [] as const,
  extensions: [],
};

function adapter(scenario: string, maxQueuedEvents?: number): SidecarAdapter {
  return new SidecarAdapter({
    manifest,
    launch: {
      executablePath: process.execPath,
      args: [fixture, scenario],
      environment: {},
      clientName: 'adapter-conformance',
      clientVersion: '0.1.0',
      requestTimeoutMs: 1_000,
      shutdownTimeoutMs: 300,
    },
    ...(maxQueuedEvents === undefined ? {} : { maxQueuedEvents }),
  });
}

describe('SidecarAdapter SPI bridge', () => {
  it.each(['text', 'pre-ack'])('passes Reference conformance with %s event timing', async (scenario) => {
    const report = await runAdapterConformance({ adapter: adapter(scenario), request });
    expect(report.events.map((event) => event.type)).toEqual(['run.started', 'assistant.delta', 'run.completed']);
  });

  it('passes the cancellation conformance case', async () => {
    const report = await runAdapterConformance({ adapter: adapter('cancel'), request, cancelAfterEvents: 1 });
    expect(report.events.at(-1)?.type).toBe('run.cancelled');
  });

  it('uses the cancel path when an AbortSignal is raised during a Run', async () => {
    const runtime = await adapter('cancel').createRuntime({});
    const controller = new AbortController();
    try {
      const iterator = runtime.startRun({ ...request, abortSignal: controller.signal })[Symbol.asyncIterator]();
      expect((await iterator.next()).value?.type).toBe('run.started');
      controller.abort();
      expect((await iterator.next()).value?.type).toBe('run.cancelled');
    } finally {
      await runtime.dispose();
    }
  });

  it('closes the owned process when a consumer stops iterating early', async () => {
    const runtime = await adapter('cancel').createRuntime({});
    const iterator = runtime.startRun(request)[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.type).toBe('run.started');
    await iterator.return?.();
    await expect(runtime.startRun(request)[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: 'DISPOSED' });
    await runtime.dispose();
  });

  it.each(['wrong-run', 'wrong-sequence', 'duplicate-terminal', 'overflow', 'crash', 'no-terminal'])(
    'fails closed on %s events',
    async (scenario) => {
      await expect(
        runAdapterConformance({ adapter: adapter(scenario, scenario === 'overflow' ? 2 : undefined), request }),
      ).rejects.toThrow();
    },
  );

  it('reports queue overflow as a resource limit', async () => {
    await expect(runAdapterConformance({ adapter: adapter('overflow', 2), request })).rejects.toMatchObject({
      code: 'RESOURCE_LIMIT',
    });
  });

  it('rejects a Wrapper manifest that differs from the pinned manifest', async () => {
    await expect(adapter('wrong-manifest').probe({})).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
  });

  it('rejects runtime context that would otherwise be silently ignored', async () => {
    await expect(adapter('text').createRuntime({ credentials: { API_KEY: 'secret-marker' } })).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
    });
  });
});
