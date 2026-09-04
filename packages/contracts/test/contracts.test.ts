import { describe, expect, it } from 'vitest';

import {
  HARNESS_PROTOCOL_VERSION,
  adapterEventSchema,
  adapterManifestSchema,
  harnessCapabilitiesSchema,
  runRequestSchema,
} from '../src/index.js';

const runId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
const eventId = '33333333-3333-4333-8333-333333333333';

describe('contracts', () => {
  it('round-trips a vendor-neutral run request', () => {
    const request = runRequestSchema.parse({
      runId,
      sessionId,
      prompt: 'Inspect the repository',
      model: { adapterId: 'cn.tencent.codebuddy', modelId: 'example-model' },
    });

    expect(JSON.parse(JSON.stringify(request))).toEqual(request);
    expect(request.permissionPolicy).toBe('interactive');
    expect(request.configScopes).toEqual([]);
  });

  it('validates manifests and capabilities', () => {
    expect(
      adapterManifestSchema.parse({
        protocolVersion: HARNESS_PROTOCOL_VERSION,
        adapterId: 'cn.yanbot.reference',
        adapterVersion: '0.1.0',
        displayName: 'Reference',
        harness: { name: 'Reference Harness' },
        runtimeKinds: ['in-process'],
      }),
    ).toBeDefined();

    expect(
      harnessCapabilitiesSchema.parse({
        'runs.cancel': { level: 'native' },
        'sessions.resume': { level: 'unsupported', reason: 'The scenario has no persisted context.' },
      }),
    ).toBeDefined();
  });

  it('rejects unordered or malformed event envelopes at the schema boundary', () => {
    expect(() =>
      adapterEventSchema.parse({
        protocolVersion: HARNESS_PROTOCOL_VERSION,
        eventId,
        runId,
        sessionId,
        sequence: 0,
        timestamp: 'not-a-date',
        type: 'run.started',
        payload: { adapterId: 'cn.yanbot.reference' },
      }),
    ).toThrow();
  });
});
