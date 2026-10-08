import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createQueueConnection } from '@yanbot-harness/cloud-queue';
import type { AdapterEvent } from '@yanbot-harness/contracts';
import { HarnessClient } from '@yanbot-harness/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuditService } from '../src/audit/audit.service.js';
import { AuthController } from '../src/auth/auth.controller.js';
import { AccessTokenGuard } from '../src/auth/auth.guard.js';
import { AuthService } from '../src/auth/auth.service.js';
import { CloudExceptionFilter } from '../src/common/cloud-exception.filter.js';
import { RequestContextMiddleware } from '../src/common/request-context.js';
import type { CloudConfig } from '../src/config.js';
import type { RunAttemptRecord } from '../src/domain.js';
import { ControlPlaneController } from '../src/control-plane/control-plane.controller.js';
import { ControlPlaneService } from '../src/control-plane/control-plane.service.js';
import { DispatchService } from '../src/dispatch/dispatch.service.js';
import { ExecutionGrantController } from '../src/execution-grants/execution-grant.controller.js';
import { ExecutionGrantService } from '../src/execution-grants/execution-grant.service.js';
import { HealthController } from '../src/health.controller.js';
import { CONTROL_PLANE_STORE } from '../src/persistence/control-plane.store.js';
import { MemoryControlPlaneStore } from '../src/persistence/memory.store.js';
import { CLOUD_CONFIG, MongoService } from '../src/persistence/mongo.service.js';
import { MongoControlPlaneStore } from '../src/persistence/mongo.store.js';
import { WorkspaceController } from '../src/workspaces/workspace.controller.js';
import { WorkspaceService } from '../src/workspaces/workspace.service.js';

describe.sequential('Remote Reference Worker real queue E2E', () => {
  let redis: Awaited<ReturnType<typeof startRedis>>;
  let root: string;
  let application: INestApplication;
  let worker: ChildProcess;
  let origin: string;
  let auth: AuthService;
  let inspect: Awaited<ReturnType<typeof startApplication>>['inspect'];
  let closeDatabase: Awaited<ReturnType<typeof startApplication>>['closeDatabase'];
  const queueName = `remote-e2e-${process.pid}`;

  beforeAll(async () => {
    redis = await startRedis();
    root = await mkdtemp(path.join(tmpdir(), 'yanbot-remote-worker-e2e-'));
    const started = await startApplication(redis.url, queueName, root);
    application = started.application;
    origin = started.origin;
    auth = started.auth;
    inspect = started.inspect;
    closeDatabase = started.closeDatabase;
    worker = spawnWorker(redis.url, queueName, origin, root);
  }, 30_000);

  afterAll(async () => {
    await stopWorker(worker);
    await application?.close();
    await closeDatabase?.();
    await redis?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('delivers one SDK run through Redis, HTTP grant scope and the independent Worker', async () => {
    const client = await createClient(auth, origin);
    const prepared = await client.prepareWorkspaceSnapshot({ manifest: { schemaVersion: 1, entries: [] }, files: [] });
    const session = await client.createSession({ adapterId: 'cn.yanbot.reference' });
    const handle = await client.createRun(session.sessionId, {
      prompt: 'e2e-secret-prompt',
      workspace: prepared.workspace,
    });
    const abort = new AbortController();
    const deadline = setTimeout(() => abort.abort(), 10_000);
    const events: AdapterEvent[] = [];
    try {
      for await (const event of handle.events({ signal: abort.signal })) events.push(event);
    } finally {
      clearTimeout(deadline);
    }
    expect(events[0]?.type).toBe('run.started');
    expect(events.at(-1)?.type).toBe('run.completed');
    await expect(handle.refresh()).resolves.toMatchObject({ status: 'completed' });
    const persisted = await inspect();
    expect(persisted.runAttempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ runId: handle.run.runId, status: 'completed', active: false }),
      ]),
    );
    expect(JSON.stringify(persisted.outbox)).not.toContain('e2e-secret-prompt');
    expect(JSON.stringify(persisted.audits)).not.toContain('e2e-secret-prompt');
  }, 15_000);

  it('round-trips an interaction through polling without queue payload expansion', async () => {
    await stopWorker(worker);
    worker = spawnWorker(redis.url, queueName, origin, root, 'question');
    const client = await createClient(auth, origin);
    const prepared = await client.prepareWorkspaceSnapshot({ manifest: { schemaVersion: 1, entries: [] }, files: [] });
    const session = await client.createSession({ adapterId: 'cn.yanbot.reference' });
    const handle = await client.createRun(session.sessionId, { prompt: 'interaction', workspace: prepared.workspace });
    const iterator = handle.events()[Symbol.asyncIterator]();
    const events: AdapterEvent[] = [];
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      events.push(next.value);
      if (next.value.type === 'interaction.requested') {
        const question = next.value.payload.questions[0]!;
        await handle.respond({
          requestId: next.value.payload.requestId,
          action: 'submit',
          answers: { [question.id]: 'yes' },
        });
      }
    }
    expect(events.map((event) => event.type)).toContain('interaction.resolved');
    expect(events.at(-1)?.type).toBe('run.completed');
  }, 15_000);

  it('converges a running cancellation to one durable terminal event', async () => {
    await stopWorker(worker);
    worker = spawnWorker(redis.url, queueName, origin, root, 'wait-for-cancel');
    const client = await createClient(auth, origin);
    const prepared = await client.prepareWorkspaceSnapshot({ manifest: { schemaVersion: 1, entries: [] }, files: [] });
    const session = await client.createSession({ adapterId: 'cn.yanbot.reference' });
    const handle = await client.createRun(session.sessionId, { prompt: 'cancel', workspace: prepared.workspace });
    const iterator = handle.events()[Symbol.asyncIterator]();
    const events: AdapterEvent[] = [];
    while (events.every((event) => event.type !== 'run.started')) {
      const next = await iterator.next();
      if (next.done) throw new Error('The run ended before it started.');
      events.push(next.value);
    }
    await handle.cancel('e2e cancellation');
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      events.push(next.value);
    }
    expect(events.filter((event) => ['run.completed', 'run.failed', 'run.cancelled'].includes(event.type))).toEqual([
      expect.objectContaining({ type: 'run.cancelled' }),
    ]);
    expect((await inspect()).runAttempts.find((attempt) => attempt.runId === handle.run.runId)).toMatchObject({
      active: false,
      failureCode: 'RUN_CANCELLED',
    });
  }, 15_000);

  it.skipIf(!process.env.HARNESS_SANDBOX_CLAUDE_IMAGE).each(['com.anthropic.claude-code-cli', 'cn.tencent.codebuddy'])(
    'delivers %s errors through SDK, HTTP, Redis, Worker and Docker',
    async (selectedAdapterId) => {
      await stopWorker(worker);
      worker = spawnWorker(redis.url, queueName, origin, root, undefined, process.env.HARNESS_SANDBOX_CLAUDE_IMAGE);
      const client = await createClient(auth, origin);
      const prepared = await client.prepareWorkspaceSnapshot({
        manifest: { schemaVersion: 1, entries: [] },
        files: [],
      });
      const session = await client.createSession({ adapterId: selectedAdapterId });
      const handle = await client.createRun(session.sessionId, {
        prompt: 'Return OK.',
        workspace: prepared.workspace,
        permissionPolicy: 'read-only',
        maxTurns: 1,
      });
      const events: AdapterEvent[] = [];
      for await (const event of handle.events({ signal: AbortSignal.timeout(45_000) })) events.push(event);
      expect(events[0]?.type).toBe('run.started');
      expect(events.at(-1)).toMatchObject({
        type: 'run.failed',
        payload: { error: { code: 'AUTHENTICATION_FAILED' } },
      });
      await expect(handle.refresh()).resolves.toMatchObject({
        status: 'failed',
        adapterId: selectedAdapterId,
      });
      const persisted = await inspect();
      expect(JSON.stringify(persisted.outbox)).not.toContain('Return OK.');
      expect(persisted.runAttempts.find((attempt) => attempt.runId === handle.run.runId)?.active).toBe(false);
    },
    60_000,
  );
});

async function createClient(auth: AuthService, origin: string): Promise<HarnessClient> {
  const identity = {
    organizationId: randomUUID(),
    organizationName: 'E2E tenant',
    userId: randomUUID(),
    userDisplayName: 'E2E user',
    deviceId: randomUUID(),
    roles: ['owner'],
  };
  const provisioned = await auth.provision(identity);
  const tokens = await auth.exchange({
    organizationId: identity.organizationId,
    deviceId: identity.deviceId,
    deviceSecret: provisioned.deviceSecret,
  });
  return new HarnessClient({ origin, accessToken: tokens.accessToken, routePrefix: '/v1' });
}

function spawnWorker(
  redisUrl: string,
  queue: string,
  internalOrigin: string,
  workspaceRoot: string,
  scenario?: 'question' | 'wait-for-cancel',
  sandboxImage?: string,
): ChildProcess {
  return spawn(process.execPath, ['apps/cloud-worker/dist/main.js'], {
    cwd: path.resolve(import.meta.dirname, '../../..'),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      WORKER_REDIS_URL: redisUrl,
      WORKER_QUEUE_NAME: queue,
      WORKER_INTERNAL_ORIGIN: internalOrigin,
      WORKER_ID: 'e2e-worker',
      WORKER_CONCURRENCY: '1',
      WORKER_HEARTBEAT_MS: '50',
      WORKER_INTERACTION_POLL_MS: '20',
      WORKER_RUN_TIMEOUT_MS: sandboxImage ? '30000' : '5000',
      ...(sandboxImage
        ? {
            WORKER_EXECUTION_MODE: 'sandbox',
            WORKER_SANDBOX_IMAGE: sandboxImage,
            WORKER_DOCKER_PATH: '/usr/bin/docker',
          }
        : {}),
      WORKER_SHARED_WORKSPACE_ROOT: workspaceRoot,
      ...(scenario === undefined ? {} : { WORKER_TEST_SCENARIO: scenario }),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

async function stopWorker(worker: ChildProcess | undefined): Promise<void> {
  if (!worker || worker.exitCode !== null) return;
  worker.kill('SIGTERM');
  await new Promise<void>((resolve) => worker.once('exit', () => resolve()));
}

async function startApplication(redisUrl: string, queue: string, workspaceRoot: string) {
  const mongoUri = process.env.HARNESS_TEST_MONGODB_URI;
  if (mongoUri) {
    const parsed = new URL(mongoUri);
    if (parsed.protocol !== 'mongodb:' || parsed.hostname !== '127.0.0.1' || parsed.username || parsed.password)
      throw new Error('Worker E2E requires a dedicated loopback test replica set.');
  }
  const config: CloudConfig = {
    nodeEnv: 'test',
    experimentalClaudeCli: Boolean(process.env.HARNESS_SANDBOX_CLAUDE_IMAGE),
    experimentalCodeBuddy: Boolean(process.env.HARNESS_SANDBOX_CLAUDE_IMAGE),
    host: '127.0.0.1',
    port: 0,
    trustProxy: false,
    tlsTerminated: false,
    mongodbUri: mongoUri ?? 'mongodb://unused',
    mongodbDatabase: `harness_ci_${randomUUID().replaceAll('-', '')}`,
    tokenPepper: 'p'.repeat(32),
    workspaceRoot,
    accessTokenTtlSeconds: 900,
    refreshTokenTtlSeconds: 604_800,
    eventRetentionSeconds: 604_800,
    workspaceTtlSeconds: 86_400,
    gitAllowedHosts: [],
    internalApiEnabled: true,
    relayEnabled: true,
    redisUrl,
    queueName: queue,
    relayIntervalMs: 20,
    relayLeaseMs: 1_000,
    runLeaseMs: process.env.HARNESS_SANDBOX_CLAUDE_IMAGE || mongoUri ? 5000 : 500,
    attemptRecoveryMs: process.env.HARNESS_SANDBOX_CLAUDE_IMAGE || mongoUri ? 10_000 : 1_000,
    maxAttempts: 3,
    retryDelayMs: 20,
    runAllowedRoles: ['owner', 'admin'],
    allowedPermissionPolicies: ['interactive', 'read-only'],
    maxActiveRunsPerOrganization: 10,
    maxRunsPerUtcDay: 1_000,
  };
  const mongo = mongoUri ? new MongoService(config) : undefined;
  if (mongo) {
    await mongo.onModuleInit();
    await mongo.syncIndexes();
  }
  const store = mongo ? new MongoControlPlaneStore(mongo) : new MemoryControlPlaneStore();
  const module = await Test.createTestingModule({
    controllers: [
      HealthController,
      AuthController,
      WorkspaceController,
      ControlPlaneController,
      ExecutionGrantController,
    ],
    providers: [
      { provide: CLOUD_CONFIG, useValue: config },
      { provide: CONTROL_PLANE_STORE, useValue: store },
      AuthService,
      AuditService,
      AccessTokenGuard,
      WorkspaceService,
      ControlPlaneService,
      ExecutionGrantService,
      DispatchService,
    ],
  }).compile();
  const application = module.createNestApplication();
  const context = new RequestContextMiddleware();
  application.use((request, response, next) => context.use(request, response, next));
  application.useGlobalFilters(new CloudExceptionFilter());
  await application.listen(0, '127.0.0.1');
  const address = application.getHttpServer().address() as { port: number };
  return {
    application,
    origin: `http://127.0.0.1:${address.port}`,
    auth: module.get(AuthService),
    closeDatabase: async () => {
      await mongo?.onModuleDestroy();
    },
    inspect: async () => {
      if (store instanceof MemoryControlPlaneStore) return store;
      return {
        runAttempts: await mongo!.model<RunAttemptRecord>('RunAttempt').find().lean().exec(),
        outbox: await mongo!.model('Outbox').find().lean().exec(),
        audits: await mongo!.model('AuditLog').find().lean().exec(),
      };
    },
  };
}

async function startRedis(): Promise<{ url: string; close(): Promise<void> }> {
  const port = await availablePort();
  const directory = await mkdtemp(path.join(tmpdir(), 'yanbot-worker-redis-'));
  const child = spawn(
    'redis-server',
    ['--bind', '127.0.0.1', '--port', String(port), '--save', '', '--appendonly', 'no', '--dir', directory],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const url = `redis://127.0.0.1:${port}/0`;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const connection = createQueueConnection(url);
    connection.on('error', () => undefined);
    try {
      await connection.connect();
      await connection.ping();
      await connection.quit();
      return {
        url,
        async close() {
          child.kill('SIGTERM');
          await new Promise<void>((resolve) => child.once('exit', () => resolve()));
          await rm(directory, { recursive: true, force: true });
        },
      };
    } catch {
      connection.disconnect();
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  child.kill('SIGTERM');
  throw new Error('The temporary Redis process did not become ready.');
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('Unable to allocate a Redis test port.');
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}
