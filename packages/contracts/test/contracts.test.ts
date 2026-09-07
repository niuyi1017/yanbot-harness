import { describe, expect, it } from 'vitest';

import {
  HARNESS_PROTOCOL_VERSION,
  adapterEventSchema,
  adapterManifestSchema,
  createLocalRunRequestSchema,
  createLocalSessionRequestSchema,
  eventCursorSchema,
  harnessCapabilitiesSchema,
  localApiErrorSchema,
  localRunSchema,
  localSessionSchema,
  runRequestSchema,
  workspaceGrantSchema,
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

  it('round-trips local session, run, grant, cursor, and error contracts', () => {
    const timestamp = '2026-09-07T08:00:00.000Z';
    const session = localSessionSchema.parse({
      protocolVersion: HARNESS_PROTOCOL_VERSION,
      sessionId,
      adapterId: 'cn.yanbot.reference',
      status: 'idle',
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const run = localRunSchema.parse({
      protocolVersion: HARNESS_PROTOCOL_VERSION,
      runId,
      sessionId,
      adapterId: session.adapterId,
      status: 'queued',
      prompt: 'Inspect the repository',
      permissionPolicy: 'interactive',
      createdAt: timestamp,
    });
    const grant = workspaceGrantSchema.parse({
      grantId: '44444444-4444-4444-8444-444444444444',
      grant: 'grant-id.secret',
      workspaceRef: '55555555-5555-4555-8555-555555555555',
      expiresAt: timestamp,
    });
    const cursor = eventCursorSchema.parse({ afterEventId: eventId });
    const error = localApiErrorSchema.parse({
      error: { code: 'PERMISSION_DENIED', message: 'Workspace access denied.' },
      requestId: '66666666-6666-4666-8666-666666666666',
    });

    for (const value of [session, run, grant, cursor, error]) {
      expect(JSON.parse(JSON.stringify(value))).toEqual(value);
    }
  });

  it('applies safe defaults to local run creation', () => {
    const request = createLocalRunRequestSchema.parse({
      prompt: 'Inspect the repository',
      workspaceGrant: 'grant-id.secret',
    });

    expect(request).toMatchObject({
      permissionPolicy: 'interactive',
      configScopes: [],
      extensions: [],
      resume: false,
    });
    expect(createLocalSessionRequestSchema.parse({ adapterId: 'cn.yanbot.reference' })).toBeDefined();
  });

  it.each(['/absolute', '\\server\\share', 'C:\\workspace', '../outside', 'nested/../../outside'])(
    'rejects unsafe relative workspace path %s',
    (relativeCwd) => {
      expect(() =>
        createLocalRunRequestSchema.parse({
          prompt: 'Inspect the repository',
          workspaceGrant: 'grant-id.secret',
          relativeCwd,
        }),
      ).toThrow();
    },
  );

  it('rejects unknown fields on local transport objects', () => {
    expect(() =>
      createLocalSessionRequestSchema.parse({
        adapterId: 'cn.yanbot.reference',
        vendorPermissionMode: 'bypassPermissions',
      }),
    ).toThrow();
  });
});
