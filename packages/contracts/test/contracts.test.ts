import { describe, expect, it } from 'vitest';

import {
  HARNESS_PROTOCOL_VERSION,
  apiErrorSchema,
  adapterEventSchema,
  adapterManifestSchema,
  adapterSummarySchema,
  createLocalRunRequestSchema,
  createLocalSessionRequestSchema,
  createRunRequestSchema,
  createRunResultSchema,
  createSessionRequestSchema,
  eventCursorSchema,
  effectiveConfigSummarySchema,
  extensionSummarySchema,
  harnessCapabilitiesSchema,
  localApiErrorSchema,
  localRunSchema,
  localSessionSchema,
  remoteRuntimeProfileSchema,
  runRequestSchema,
  runSchema,
  runtimeDiscoverySchema,
  runtimeHealthSchema,
  runtimeProfileSchema,
  sessionSchema,
  workspaceGrantSchema,
  workspaceSourceSchema,
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

  it('keeps Local schemas as identity aliases of the neutral contracts', () => {
    expect(localSessionSchema).toBe(sessionSchema);
    expect(localRunSchema).toBe(runSchema);
    expect(createLocalSessionRequestSchema).toBe(createSessionRequestSchema);
    expect(createLocalRunRequestSchema).toBe(createRunRequestSchema);
    expect(localApiErrorSchema).toBe(apiErrorSchema);

    const request = createRunRequestSchema.parse({
      prompt: 'Inspect the repository',
      workspaceGrant: 'grant-id.secret',
    });
    const run = runSchema.parse({
      protocolVersion: HARNESS_PROTOCOL_VERSION,
      runId,
      sessionId,
      adapterId: 'cn.yanbot.reference',
      status: 'queued',
      prompt: request.prompt,
      permissionPolicy: request.permissionPolicy,
      createdAt: '2026-09-17T08:00:00.000Z',
    });

    expect(createRunResultSchema.parse({ run, reused: false })).toEqual({ run, reused: false });
  });

  it('round-trips workspace sources and constrained Runtime profiles', () => {
    const localSource = workspaceSourceSchema.parse({
      kind: 'local-path-grant',
      workspaceGrant: 'grant-id.secret',
      relativeCwd: 'packages/contracts',
    });
    const remoteSource = workspaceSourceSchema.parse({
      kind: 'uploaded-snapshot',
      uploadId: 'upload-1',
      digest: `sha256:${'a'.repeat(64)}`,
    });
    const localProfile = runtimeProfileSchema.parse({
      executionMode: 'local',
      serviceVersion: '0.1.0-preview.3',
      authentication: 'local-descriptor',
      capabilities: {
        workspaceSources: ['local-path-grant'],
        eventReplay: { durability: 'process' },
        interactions: { supported: true, maxWaitSeconds: 300 },
      },
    });
    const remoteProfile = remoteRuntimeProfileSchema.parse({
      executionMode: 'remote',
      serviceVersion: '0.1.0-preview.3',
      authentication: 'bearer',
      capabilities: {
        workspaceSources: ['git-ref', 'uploaded-snapshot'],
        eventReplay: { durability: 'durable', retentionSeconds: 86_400 },
        interactions: { supported: true, maxWaitSeconds: 3_600 },
      },
    });

    for (const value of [localSource, remoteSource, localProfile, remoteProfile]) {
      expect(JSON.parse(JSON.stringify(value))).toEqual(value);
    }
    expect(() =>
      runtimeProfileSchema.parse({
        ...localProfile,
        authentication: 'bearer',
      }),
    ).toThrow();
    expect(() =>
      remoteRuntimeProfileSchema.parse({
        ...remoteProfile,
        capabilities: { ...remoteProfile.capabilities, workspaceSources: ['local-path-grant'] },
      }),
    ).toThrow();
  });

  it('discovers an unknown protocol major without accepting it as a current resource version', () => {
    const discovery = runtimeDiscoverySchema.parse({
      service: 'future-runtime',
      protocolVersion: '2.0.0',
      status: 'ok',
      startedAt: '2026-09-17T08:00:00.000Z',
      profile: {
        executionMode: 'remote',
        serviceVersion: '0.2.0',
        authentication: 'bearer',
        capabilities: {
          workspaceSources: ['uploaded-snapshot'],
          eventReplay: { durability: 'durable', retentionSeconds: 86_400 },
          interactions: { supported: false },
        },
      },
    });

    expect(discovery.protocolVersion).toBe('2.0.0');
    expect(() => sessionSchema.parse({ protocolVersion: discovery.protocolVersion })).toThrow();
  });

  it('keeps public error codes stable at the API envelope boundary', () => {
    const parsed = apiErrorSchema.parse({
      error: { code: 'CAPABILITY_UNSUPPORTED', message: 'Workspace source is not supported.' },
      requestId: '66666666-6666-4666-8666-666666666666',
    });
    expect(parsed.error.code).toBe('CAPABILITY_UNSUPPORTED');
    expect(() =>
      apiErrorSchema.parse({
        error: { code: 'REMOTE_MAGIC_FAILED', message: 'unstable' },
        requestId: parsed.requestId,
      }),
    ).toThrow();
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

  it('validates client discovery response contracts', () => {
    const manifest = adapterManifestSchema.parse({
      protocolVersion: HARNESS_PROTOCOL_VERSION,
      adapterId: 'cn.yanbot.reference',
      adapterVersion: '0.1.0',
      displayName: 'Reference',
      harness: { name: 'Reference Harness' },
      runtimeKinds: ['in-process'],
    });
    expect(
      adapterSummarySchema.parse({ manifest, capabilities: { 'runs.cancel': { level: 'native' } } }),
    ).toBeDefined();
    expect(
      extensionSummarySchema.parse({
        descriptor: {
          extensionId: 'sample.skill',
          kind: 'skill',
          version: '1.0.0',
          displayName: 'Sample',
          source: 'project',
        },
        supported: true,
      }),
    ).toBeDefined();
    expect(
      effectiveConfigSummarySchema.parse({
        scopes: ['project', 'enforced'],
        adapterKeys: [],
        extensionIds: [],
        credentialKeys: [],
      }),
    ).toBeDefined();
    expect(
      runtimeHealthSchema.parse({
        service: 'yanbot-harness-local-runtime',
        protocolVersion: HARNESS_PROTOCOL_VERSION,
        status: 'ok',
        startedAt: '2026-09-07T08:00:00.000Z',
      }),
    ).toBeDefined();
    expect(() =>
      runtimeHealthSchema.parse({
        service: 'yanbot-harness-local-runtime',
        protocolVersion: HARNESS_PROTOCOL_VERSION,
        status: 'ok',
        startedAt: '2026-09-07T08:00:00.000Z',
        token: 'forbidden',
      }),
    ).toThrow();
  });
});
