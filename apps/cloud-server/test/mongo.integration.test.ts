import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HARNESS_PROTOCOL_VERSION } from '@yanbot-harness/contracts';
import { ExecutionGrantService } from '../src/execution-grants/execution-grant.service.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseCloudConfig, type CloudConfig } from '../src/config.js';
import { AuthService } from '../src/auth/auth.service.js';
import { AuditService } from '../src/audit/audit.service.js';
import { ControlPlaneService } from '../src/control-plane/control-plane.service.js';
import type { TenantPrincipal, WorkspaceRecord } from '../src/domain.js';
import { MongoService } from '../src/persistence/mongo.service.js';
import { MongoControlPlaneStore } from '../src/persistence/mongo.store.js';
import { WorkspaceService } from '../src/workspaces/workspace.service.js';

const uri = process.env.HARNESS_TEST_MONGODB_URI;
if (uri) {
  const parsed = new URL(uri);
  if (parsed.protocol !== 'mongodb:' || parsed.hostname !== '127.0.0.1' || parsed.username || parsed.password)
    throw new Error('Mongo integration tests require a dedicated loopback replica set without credentials.');
}
const configuration = parseCloudConfig({
  NODE_ENV: 'test',
  MONGODB_URI: uri ?? 'mongodb://127.0.0.1:27017',
  CLOUD_MONGODB_DATABASE: `harness_ci_${randomUUID().replaceAll('-', '')}`,
  CLOUD_TOKEN_PEPPER: 'test-only-pepper-'.repeat(3),
  CLOUD_WORKSPACE_ROOT: '/tmp/harness-ci-unused-snapshots',
  CLOUD_GIT_ALLOWED_HOSTS: 'github.com',
});

describe.skipIf(!uri)('Real Mongo replica-set persistence', () => {
  let mongo: MongoService;
  beforeAll(async () => {
    mongo = new MongoService(configuration);
    await mongo.onModuleInit();
    await mongo.syncIndexes();
  }, 30_000);
  afterAll(async () => {
    await mongo?.onModuleDestroy();
  });

  function services(config: CloudConfig = configuration) {
    const store = new MongoControlPlaneStore(mongo);
    const service = new ControlPlaneService(
      store,
      new WorkspaceService(store, config),
      config,
      new AuditService(store, config),
    );
    return { store, service, auth: new AuthService(store, config) };
  }
  async function setup(overrides: Partial<CloudConfig> = {}) {
    const config = { ...configuration, ...overrides };
    const instance = services(config);
    const principal: TenantPrincipal = {
      organizationId: randomUUID(),
      userId: randomUUID(),
      deviceId: randomUUID(),
      roles: ['owner'],
    };
    const workspace: WorkspaceRecord = {
      organizationId: principal.organizationId,
      userId: principal.userId,
      workspaceRef: randomUUID(),
      source: { kind: 'git-ref', repository: 'https://github.com/example/repo.git', ref: 'a'.repeat(40) },
      digest: `sha256:${'b'.repeat(64)}`,
      status: 'ready',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 300_000),
    };
    await instance.store.insertWorkspace(workspace);
    const session = await instance.service.createSession(principal, { adapterId: 'cn.yanbot.reference' });
    const input = { prompt: 'synthetic-mongo-test', workspace: workspace.source };
    return { ...instance, principal, workspace, session, input, config };
  }
  async function counts(organizationId: string) {
    return {
      runs: await mongo.model('HarnessRun').countDocuments({ organizationId }),
      outbox: await mongo.model('Outbox').countDocuments({ organizationId }),
    };
  }

  it('migrates the legacy sparse index explicitly and is idempotent', async () => {
    const collection = mongo.model('HarnessRun').collection;
    await collection.dropIndex('run_idempotency_present');
    await collection.createIndex(
      { organizationId: 1, sessionId: 1, idempotencyKey: 1 },
      { unique: true, sparse: true },
    );
    await mongo.syncIndexes();
    await mongo.syncIndexes();
    const indexes = await collection.indexes();
    expect(indexes.find((index) => index.name === 'organizationId_1_sessionId_1_idempotencyKey_1')).toBeUndefined();
    expect(indexes.find((index) => index.name === 'run_idempotency_present')).toMatchObject({
      unique: true,
      partialFilterExpression: { idempotencyKey: { $type: 'string' } },
    });
  });

  it('atomically promotes checkpoints, survives service replacement and fences an expired worker', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'harness-mongo-state-'));
    try {
      const f = await setup({ workspaceRoot: root, internalApiEnabled: true });
      const created = await f.service.createRun(f.principal, f.session.sessionId, f.input);
      const grants = new ExecutionGrantService(
        f.store,
        f.auth,
        f.service,
        f.config,
        new AuditService(f.store, f.config),
      );
      const now = new Date();
      await f.store.insertRunAttempt({
        organizationId: f.principal.organizationId,
        runId: created.run.runId,
        attempt: 1,
        queueJobId: `run-${created.run.runId}-attempt-1`,
        status: 'queued',
        active: true,
        createdAt: now,
        updatedAt: now,
      });
      const issued = await grants.issue((await f.store.findRun(f.principal.organizationId, created.run.runId))!);
      await grants.claim(issued.executionGrant, 'worker-state');
      const heartbeatTime = new Date();
      for (let index = 0; index < 2; index++)
        expect(
          await f.store.heartbeatRunAttempt(
            f.principal.organizationId,
            created.run.runId,
            1,
            'worker-state',
            heartbeatTime,
            new Date(heartbeatTime.getTime() + 30_000),
          ),
        ).toBe(true);
      expect((await f.store.findRunAttempt(f.principal.organizationId, created.run.runId, 1))?.fenceRevision).toBe(2);
      await grants.checkpoint(issued.executionGrant, created.run.runId, 1, 'worker-state', {
        manifest: { schemaVersion: 1, entries: [] },
        files: [],
      });
      const terminal = {
        protocolVersion: HARNESS_PROTOCOL_VERSION,
        eventId: randomUUID(),
        runId: created.run.runId,
        sessionId: f.session.sessionId,
        sequence: 1,
        timestamp: new Date().toISOString(),
        type: 'run.completed',
        payload: {},
      };
      await expect(
        f.store.transaction(async () => {
          await grants.append(issued.executionGrant, created.run.runId, 1, terminal, 'worker-state');
          throw new Error('checkpoint-rollback');
        }),
      ).rejects.toThrow('checkpoint-rollback');
      expect((await f.store.findSession(f.principal.organizationId, f.session.sessionId))?.checkpoint).toBeUndefined();
      expect(await f.store.listEvents(f.principal.organizationId, created.run.runId, 0)).toHaveLength(0);
      await grants.append(issued.executionGrant, created.run.runId, 1, terminal, 'worker-state');
      const replacement = services(f.config);
      const restored = await replacement.service.createRun(f.principal, f.session.sessionId, {
        ...f.input,
        resume: true,
      });
      expect(
        (await replacement.store.findRun(f.principal.organizationId, restored.run.runId))?.resumeFrom,
      ).toMatchObject({ version: 1, baseDigest: f.workspace.digest });
      await replacement.store.insertRunAttempt({
        organizationId: f.principal.organizationId,
        runId: restored.run.runId,
        attempt: 1,
        queueJobId: `run-${restored.run.runId}-attempt-1`,
        status: 'queued',
        active: true,
        createdAt: now,
        updatedAt: now,
      });
      const next = await grants.issue(
        (await replacement.store.findRun(f.principal.organizationId, restored.run.runId))!,
      );
      await grants.claim(next.executionGrant, 'worker-replacement');
      await mongo
        .model('RunAttempt')
        .updateOne({ runId: restored.run.runId }, { $set: { leaseExpiresAt: new Date(0) } });
      await expect(
        grants.checkpoint(next.executionGrant, restored.run.runId, 1, 'worker-replacement', {
          manifest: { schemaVersion: 1, entries: [] },
          files: [],
        }),
      ).rejects.toMatchObject({ status: 403 });
      expect(
        (await replacement.store.findSession(f.principal.organizationId, f.session.sessionId))?.checkpoint?.version,
      ).toBe(1);
      await replacement.service.cancelRun(f.principal, restored.run.runId);
      await replacement.store.pruneExpiredCheckpoints(new Date(Date.now() + 2 * 86_400_000));
      expect(
        (await replacement.store.findSession(f.principal.organizationId, f.session.sessionId))?.checkpoint,
      ).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('allows sequential no-key runs while enforcing explicit-key uniqueness', async () => {
    const f = await setup();
    const first = await f.service.createRun(f.principal, f.session.sessionId, f.input);
    await f.service.cancelRun(f.principal, first.run.runId);
    const second = await f.service.createRun(f.principal, f.session.sessionId, f.input);
    expect(second.run.runId).not.toBe(first.run.runId);
    await f.service.cancelRun(f.principal, second.run.runId);
    const keyed = await f.service.createRun(f.principal, f.session.sessionId, f.input, 'key');
    expect(await f.service.createRun(f.principal, f.session.sessionId, f.input, 'key')).toEqual({
      ...keyed,
      reused: true,
    });
    const record = await f.store.findRun(f.principal.organizationId, keyed.run.runId);
    await expect(mongo.model('HarnessRun').create({ ...record, runId: randomUUID() })).rejects.toMatchObject({
      code: 11000,
    });
    expect(await counts(f.principal.organizationId)).toEqual({ runs: 3, outbox: 3 });
  });

  it('deduplicates concurrent identical requests with one admission and outbox', async () => {
    const f = await setup();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => f.service.createRun(f.principal, f.session.sessionId, f.input, 'race')),
    );
    expect(new Set(results.map((result) => result.run.runId)).size).toBe(1);
    expect(results.filter((result) => !result.reused)).toHaveLength(1);
    expect(await counts(f.principal.organizationId)).toEqual({ runs: 1, outbox: 1 });
    expect(await f.store.findAdmissionState(f.principal.organizationId)).toMatchObject({
      activeRuns: 1,
      admittedRuns: 1,
    });
  });

  it('serializes the Session write lock and returns domain conflicts', async () => {
    const f = await setup();
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, index) =>
        f.service.createRun(f.principal, f.session.sessionId, { ...f.input, prompt: `request-${index}` }),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    for (const result of results)
      if (result.status === 'rejected') expect(result.reason).toMatchObject({ status: 409 });
    expect(await counts(f.principal.organizationId)).toEqual({ runs: 1, outbox: 1 });
  });

  it('enforces organization concurrency across different sessions on first admission', async () => {
    const f = await setup({ maxActiveRunsPerOrganization: 1 });
    const sessions = await Promise.all(
      Array.from({ length: 5 }, () => f.service.createSession(f.principal, { adapterId: 'cn.yanbot.reference' })),
    );
    const results = await Promise.allSettled(
      sessions.map((session) => f.service.createRun(f.principal, session.sessionId, f.input)),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    for (const result of results)
      if (result.status === 'rejected') expect(result.reason).toMatchObject({ status: 429 });
    expect(await counts(f.principal.organizationId)).toEqual({ runs: 1, outbox: 1 });
    expect(await f.store.findAdmissionState(f.principal.organizationId)).toMatchObject({
      activeRuns: 1,
      admittedRuns: 1,
    });
  });

  it('rolls back admission, Run, outbox and Session when a transaction fails', async () => {
    const f = await setup();
    await expect(
      f.store.transaction(async () => {
        await f.service.createRun(f.principal, f.session.sessionId, f.input);
        throw new Error('injected-transaction-failure');
      }),
    ).rejects.toThrow('injected-transaction-failure');
    expect(await counts(f.principal.organizationId)).toEqual({ runs: 0, outbox: 0 });
    expect(await f.store.findAdmissionState(f.principal.organizationId)).toBeUndefined();
    expect((await f.store.findSession(f.principal.organizationId, f.session.sessionId))?.value.status).toBe('idle');
  });

  it('commits refresh-reuse family revocation despite authentication rejection', async () => {
    const f = await setup();
    const provisioned = await f.auth.provision({ ...f.principal, organizationName: 'CI', userDisplayName: 'CI' });
    const first = await f.auth.exchange({
      organizationId: f.principal.organizationId,
      deviceId: f.principal.deviceId,
      deviceSecret: provisioned.deviceSecret,
    });
    const second = await f.auth.refresh({ refreshToken: first.refreshToken });
    await expect(f.auth.refresh({ refreshToken: first.refreshToken })).rejects.toMatchObject({ status: 401 });
    const reloaded = services().auth;
    await expect(reloaded.authenticate(`Bearer ${first.accessToken}`)).rejects.toMatchObject({ status: 401 });
    await expect(reloaded.authenticate(`Bearer ${second.accessToken}`)).rejects.toMatchObject({ status: 401 });
    await expect(reloaded.refresh({ refreshToken: second.refreshToken })).rejects.toMatchObject({ status: 401 });
  });

  it('reconnects and replays one durable terminal event with tenant/cursor isolation', async () => {
    const f = await setup();
    const created = await f.service.createRun(f.principal, f.session.sessionId, f.input);
    const results = await Promise.all(
      Array.from({ length: 4 }, () => f.service.cancelRun(f.principal, created.run.runId)),
    );
    expect(results.every((run) => run.status === 'cancelled')).toBe(true);
    expect(await f.store.findAdmissionState(f.principal.organizationId)).toMatchObject({
      activeRuns: 0,
      admittedRuns: 1,
    });
    await mongo.onModuleDestroy();
    mongo = new MongoService(configuration);
    await mongo.onModuleInit();
    const reloaded = services();
    expect(await reloaded.service.getRun(f.principal, created.run.runId)).toMatchObject({ status: 'cancelled' });
    const events = await reloaded.service.listEvents(f.principal, created.run.runId);
    expect(events).toHaveLength(1);
    expect(await reloaded.service.listEvents(f.principal, created.run.runId, events[0]!.eventId)).toEqual([]);
    await expect(
      reloaded.service.listEvents({ ...f.principal, organizationId: randomUUID() }, created.run.runId),
    ).rejects.toMatchObject({ status: 404 });
    await expect(reloaded.service.listEvents(f.principal, created.run.runId, randomUUID())).rejects.toMatchObject({
      status: 404,
    });
  });
});
