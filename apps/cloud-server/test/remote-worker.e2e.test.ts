import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createQueueConnection } from '@yanbot-harness/cloud-queue';
import type { AdapterEvent } from '@yanbot-harness/contracts';
import { HarnessClient } from '@yanbot-harness/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ModelBrokerController } from '../src/model-broker/model-broker.controller.js';
import { ModelBrokerService } from '../src/model-broker/model-broker.service.js';
import { MODEL_TRANSPORT } from '../src/model-broker/forward.js';
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

const brokerOrganization = randomUUID();
const brokerModel = 'claude-sonnet-4-6';
const brokerSecret = 'synthetic-e2e-broker-secret-not-real';
let brokerWait = false;
let brokerAborted = false;
const brokerRequests: unknown[] = [];
const workerDiagnostics = new WeakMap<ChildProcess, string>();

function modelResponse(body: { model: string; stream?: boolean }, signal: AbortSignal): Response {
  const message = {
    id: 'msg_fixture',
    type: 'message',
    role: 'assistant',
    model: body.model,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 5, output_tokens: 0 },
  };
  if (!body.stream)
    return Response.json({
      ...message,
      content: [{ type: 'text', text: 'BRIDGE_OK' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 2 },
    });
  return new Response(
    new ReadableStream({
      start(controller) {
        const emit = (type: string, extra: object = {}) =>
          controller.enqueue(
            new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`),
          );
        emit('message_start', { message });
        emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
        emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'BRIDGE_OK' } });
        if (brokerWait) {
          // Advance the broker's bounded redaction tail while leaving the message open.
          emit('ping');
          emit('ping');
          signal.addEventListener(
            'abort',
            () => {
              brokerAborted = true;
              try {
                controller.close();
              } catch {
                /* The consumer may already have cancelled the stream. */
              }
            },
            { once: true },
          );
          return;
        }
        emit('content_block_stop', { index: 0 });
        emit('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } });
        emit('message_stop');
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

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
    'runs pinned %s through the disconnected Guest, Worker and scoped Broker',
    async (selectedAdapterId) => {
      await stopWorker(worker);
      worker = spawnWorker(
        redis.url,
        queueName,
        origin,
        root,
        undefined,
        process.env.HARNESS_SANDBOX_CLAUDE_IMAGE,
        true,
      );
      const client = await createClient(auth, origin, brokerOrganization);
      const prepared = await client.prepareWorkspaceSnapshot({
        manifest: { schemaVersion: 1, entries: [] },
        files: [],
      });
      const session = await client.createSession({ adapterId: selectedAdapterId });
      brokerRequests.length = 0;
      const handle = await client.createRun(session.sessionId, {
        prompt: 'Return BRIDGE_OK.',
        workspace: prepared.workspace,
        permissionPolicy: 'read-only',
        model: { adapterId: selectedAdapterId, modelId: brokerModel },
      });
      const events: AdapterEvent[] = [];
      for await (const event of handle.events({ signal: AbortSignal.timeout(45_000) })) events.push(event);
      expect(events.at(-1)?.type).toBe('run.completed');
      expect(
        events
          .filter((event) => event.type === 'assistant.delta')
          .map((event) => event.payload.text)
          .join(''),
      ).toContain('BRIDGE_OK');
      expect(brokerRequests.length).toBeGreaterThan(0);
      expect(brokerRequests.length).toBeLessThanOrEqual(2);
      expect(brokerRequests[0]).toMatchObject({ model: brokerModel, max_tokens: 1024 });
      expect(await handle.refresh()).toMatchObject({ status: 'completed' });
      const state = await inspect();
      expect(JSON.stringify({ events, audits: state.audits, outbox: state.outbox })).not.toContain(brokerSecret);
    },
    60_000,
  );

  it.skipIf(!process.env.HARNESS_SANDBOX_CLAUDE_IMAGE).each(['com.anthropic.claude-code-cli', 'cn.tencent.codebuddy'])(
    'cancels an in-flight %s sandbox model stream and revokes its broker connection',
    async (selectedAdapterId) => {
      brokerWait = true;
      brokerAborted = false;
      try {
        const client = await createClient(auth, origin, brokerOrganization);
        const prepared = await client.prepareWorkspaceSnapshot({
          manifest: { schemaVersion: 1, entries: [] },
          files: [],
        });
        const session = await client.createSession({ adapterId: selectedAdapterId });
        const handle = await client.createRun(session.sessionId, {
          prompt: 'Return BRIDGE_OK.',
          workspace: prepared.workspace,
          permissionPolicy: 'read-only',
          model: { adapterId: selectedAdapterId, modelId: brokerModel },
        });
        const events: AdapterEvent[] = [];
        for await (const event of handle.events({ signal: AbortSignal.timeout(45_000) })) {
          events.push(event);
          if (event.type === 'assistant.delta') await handle.cancel('model bridge test');
        }
        expect(
          events.at(-1)?.type,
          JSON.stringify({
            workerExit: worker.exitCode,
            workerSignal: worker.signalCode,
            stderr: workerDiagnostics.get(worker),
            runStatus: (await handle.refresh()).status,
          }),
        ).toBe('run.cancelled');
        await expect.poll(() => brokerAborted, { timeout: 10_000 }).toBe(true);
      } finally {
        brokerWait = false;
      }
    },
    60_000,
  );

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

async function createClient(auth: AuthService, origin: string, organizationId = randomUUID()): Promise<HarnessClient> {
  const identity = {
    organizationId,
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
  modelBridgeEnabled = false,
): ChildProcess {
  const child = spawn(process.execPath, ['apps/cloud-worker/dist/main.js'], {
    cwd: path.resolve(import.meta.dirname, '../../..'),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      WORKER_REDIS_URL: redisUrl,
      WORKER_QUEUE_NAME: queue,
      WORKER_INTERNAL_ORIGIN: internalOrigin,
      WORKER_ID: 'e2e-worker',
      WORKER_CONCURRENCY: '1',
      WORKER_MODEL_BRIDGE_ENABLED: String(modelBridgeEnabled),
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
  child.stderr?.on('data', (bytes) =>
    workerDiagnostics.set(
      child,
      ((workerDiagnostics.get(child) ?? '') + String(bytes))
        .replaceAll(brokerSecret, '[REDACTED]')
        .replace(/yhe_[A-Za-z0-9_-]+/g, '[REDACTED]')
        .slice(-8192),
    ),
  );
  return child;
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
  let modelBrokerPoliciesFile: string | undefined;
  if (process.env.HARNESS_SANDBOX_CLAUDE_IMAGE) {
    modelBrokerPoliciesFile = path.join(workspaceRoot, 'broker-policy.json');
    const apiKeyFile = path.join(workspaceRoot, 'broker-key');
    await writeFile(apiKeyFile, brokerSecret, { mode: 0o600 });
    await writeFile(
      modelBrokerPoliciesFile,
      JSON.stringify({
        version: 1,
        policies: ['com.anthropic.claude-code-cli', 'cn.tencent.codebuddy'].map((adapterId) => ({
          organizationId: brokerOrganization,
          adapterId,
          upstream: 'anthropic-messages',
          models: [brokerModel],
          apiKeyFile,
          maxRequests: 2,
          maxOutputTokens: 1024,
        })),
      }),
      { mode: 0o600 },
    );
  }
  const config: CloudConfig = {
    ...(modelBrokerPoliciesFile ? { modelBrokerPoliciesFile } : {}),
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
      ModelBrokerController,
      HealthController,
      AuthController,
      WorkspaceController,
      ControlPlaneController,
      ExecutionGrantController,
    ],
    providers: [
      { provide: CLOUD_CONFIG, useValue: config },
      { provide: CONTROL_PLANE_STORE, useValue: store },
      ModelBrokerService,
      {
        provide: MODEL_TRANSPORT,
        useValue: async (url: string, init: RequestInit) => {
          expect(url).toBe('https://api.anthropic.com/v1/messages');
          expect(new Headers(init.headers).get('x-api-key')).toBe(brokerSecret);
          const body = JSON.parse(String(init.body));
          brokerRequests.push(body);
          return modelResponse(body, init.signal!);
        },
      },
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
