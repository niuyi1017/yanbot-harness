import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Test } from '@nestjs/testing';
import { json } from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { parseCloudConfig } from '../src/config.js';
import { AuthService } from '../src/auth/auth.service.js';
import { AuditService } from '../src/audit/audit.service.js';
import { CloudExceptionFilter } from '../src/common/cloud-exception.filter.js';
import { RequestContextMiddleware } from '../src/common/request-context.js';
import { ControlPlaneService } from '../src/control-plane/control-plane.service.js';
import { ExecutionGrantService } from '../src/execution-grants/execution-grant.service.js';
import type { TenantPrincipal } from '../src/domain.js';
import { CONTROL_PLANE_STORE } from '../src/persistence/control-plane.store.js';
import { MemoryControlPlaneStore } from '../src/persistence/memory.store.js';
import { CLOUD_CONFIG, MongoService } from '../src/persistence/mongo.service.js';
import { MongoControlPlaneStore } from '../src/persistence/mongo.store.js';
import { WorkspaceService } from '../src/workspaces/workspace.service.js';
import { ModelBrokerService } from '../src/model-broker/model-broker.service.js';
import { ModelBrokerController } from '../src/model-broker/model-broker.controller.js';
import { MODEL_TRANSPORT } from '../src/model-broker/forward.js';
import { CLAUDE_ADAPTER_ID, MAX_MODEL_REQUEST_BYTES } from '../src/model-broker/policy.js';

const secret = 'synthetic-private-broker-key-never-real';
const model = 'model-test';
const requestBody = { model, max_tokens: 32, messages: [{ role: 'user', content: 'private-test-prompt' }] };
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

describe.skipIf(process.platform === 'win32')('Run model broker HTTP boundary', () => {
  it('streams through real HTTP with fixed headers, scoped credentials and safe audit', async () => {
    const f = await setup('stream');
    const response = await f.request({ ...requestBody, stream: true });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const text = await response.text();
    expect(text).toContain('[REDACTED]');
    expect(text).not.toContain(secret);
    expect(text).not.toContain(f.issued.executionGrant);
    expect(f.received).toHaveLength(1);
    expect(f.received[0]).toMatchObject({
      apiKey: secret,
      version: '2023-06-01',
      body: { ...requestBody, stream: true },
    });
    const state = await f.store.findRun(f.principal.organizationId, f.run.runId);
    expect(state?.modelRequestCount).toBe(1);
    const audits = f.mongo
      ? await f.mongo.model('AuditLog').find().lean()
      : (f.store as MemoryControlPlaneStore).audits;
    const persisted = JSON.stringify({ audits, state });
    expect(persisted).not.toContain(secret);
    expect(persisted).not.toContain(f.issued.executionGrant);
    expect(JSON.stringify(audits)).not.toContain('private-test-prompt');
  });
  it('rejects bad tokens, worker, run and attempt before credential access', async () => {
    const f = await setup();
    await rm(f.keyFile);
    for (const [url, headers, expected] of [
      [f.url, { authorization: 'Bearer yha_invalid' }, 401],
      [f.url, { 'x-worker-id': 'wrong-worker' }, 403],
      [f.url.replace('attempt=1', 'attempt=2'), {}, 403],
      [f.url.replace(f.run.runId, randomUUID()), {}, 403],
    ] as const) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { ...f.headers, ...headers },
        body: JSON.stringify(requestBody),
      });
      expect(response.status).toBe(expected);
    }
    expect(f.received).toHaveLength(0);
  });
  it('rejects unclaimed and revoked grants, inactive attempts and missing tenant policy', async () => {
    const f = await setup();
    const record = (await f.store.findRun(f.principal.organizationId, f.run.runId))!;
    const unclaimed = await f.grants.issue(record);
    expect((await f.request(requestBody, { authorization: `Bearer ${unclaimed.executionGrant}` })).status).toBe(403);
    const other = await f.createRun({ ...f.principal, organizationId: randomUUID() });
    expect(
      (
        await fetch(f.url.replace(f.run.runId, other.run.runId), {
          method: 'POST',
          headers: { ...f.headers, authorization: `Bearer ${other.issued.executionGrant}` },
          body: JSON.stringify(requestBody),
        })
      ).status,
    ).toBe(403);
    const attempt = (await f.store.findRunAttempt(f.principal.organizationId, f.run.runId, 1))!;
    await f.store.replaceRunAttempt({ ...attempt, active: false, status: 'abandoned' });
    expect((await f.request()).status).toBe(403);
    await f.store.revokeRunGrants(f.principal.organizationId, f.run.runId, new Date());
    expect((await f.request()).status).toBe(403);
    expect(f.received).toHaveLength(0);
  });
  it('enforces model and request limits and does not reserve invalid inputs', async () => {
    const f = await setup();
    for (const value of [
      { ...requestBody, model: 'other' },
      { ...requestBody, max_tokens: 65 },
      { ...requestBody, tools: [] },
      { ...requestBody, endpoint: 'http://169.254.169.254' },
    ])
      expect((await f.request(value)).status).toBe(422);
    expect(
      (
        await f.request({
          ...requestBody,
          messages: Array.from({ length: 5 }, () => ({ role: 'user', content: 'x'.repeat(60_000) })),
        })
      ).status,
    ).toBe(413);
    expect((await f.store.findRun(f.principal.organizationId, f.run.runId))?.modelRequestCount).toBeUndefined();
    expect(f.received).toHaveLength(0);
  });
  it('reserves a persistent per-Run limit atomically under concurrent HTTP requests', async () => {
    const f = await setup();
    const responses = await Promise.all(Array.from({ length: 8 }, () => f.request()));
    await Promise.all(responses.map((response) => response.text()));
    expect(responses.filter((response) => response.status === 200)).toHaveLength(2);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(6);
    expect(f.received).toHaveLength(2);
    expect((await f.store.findRun(f.principal.organizationId, f.run.runId))?.modelRequestCount).toBe(2);
    if (f.mongo) {
      const reconnected = new MongoService(f.config);
      await reconnected.onModuleInit();
      try {
        const store = new MongoControlPlaneStore(reconnected);
        expect((await store.findRun(f.principal.organizationId, f.run.runId))?.modelRequestCount).toBe(2);
        expect(await store.reserveModelRequest(f.principal.organizationId, f.run.runId, 2)).toBe(false);
      } finally {
        await reconnected.onModuleDestroy();
      }
    }
    await f.control.cancelRun(f.principal, f.run.runId);
    expect((await f.store.findRun(f.principal.organizationId, f.run.runId))?.modelRequestCount).toBe(2);
    expect((await f.request()).status).toBe(403);
  });
  it('discards upstream diagnostic bodies and still charges the attempted request', async () => {
    const f = await setup('error');
    const response = await f.request();
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain(secret);
    expect((await f.store.findRun(f.principal.organizationId, f.run.runId))?.modelRequestCount).toBe(1);
  });
  it('cancels active upstream streaming when the Run is cancelled', async () => {
    const f = await setup('endless');
    const response = await f.request({ ...requestBody, stream: true });
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    await f.control.cancelRun(f.principal, f.run.runId);
    await expect(
      (async () => {
        while (!(await reader.read()).done) {
          /* Drain until the authorization cut-off. */
        }
      })(),
    ).rejects.toThrow();
    await waitFor(() => f.wasClosed());
  }, 10_000);
  it('cancels upstream when the client disconnects or the worker lease expires', async () => {
    const f = await setup('endless');
    const response = await f.request({ ...requestBody, stream: true });
    await response.body!.cancel();
    await waitFor(() => f.wasClosed());
    f.resetClosed();
    const again = await f.request({ ...requestBody, stream: true });
    const attempt = (await f.store.findRunAttempt(f.principal.organizationId, f.run.runId, 1))!;
    await f.store.replaceRunAttempt({ ...attempt, leaseExpiresAt: new Date(0) });
    await expect(again.text()).rejects.toThrow();
    await waitFor(() => f.wasClosed());
  }, 10_000);
});

async function waitFor(predicate: () => boolean) {
  for (let index = 0; index < 100; index++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('The test upstream did not close.');
}

async function setup(mode: 'json' | 'stream' | 'error' | 'endless' = 'json') {
  const root = await mkdtemp(path.join(tmpdir(), 'harness-broker-test-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const principal: TenantPrincipal = {
    organizationId: randomUUID(),
    userId: randomUUID(),
    deviceId: randomUUID(),
    roles: ['owner'],
  };
  const keyFile = path.join(root, 'credential');
  const policiesFile = path.join(root, 'policies.json');
  await writeFile(keyFile, secret, { mode: 0o600 });
  await writeFile(
    policiesFile,
    JSON.stringify({
      version: 1,
      policies: [
        {
          organizationId: principal.organizationId,
          adapterId: CLAUDE_ADAPTER_ID,
          models: [model],
          apiKeyFile: keyFile,
          maxRequests: 2,
          maxOutputTokens: 64,
        },
      ],
    }),
    { mode: 0o600 },
  );
  const mongoUri = process.env.HARNESS_TEST_MONGODB_URI;
  if (mongoUri) {
    const parsed = new URL(mongoUri);
    if (parsed.protocol !== 'mongodb:' || parsed.hostname !== '127.0.0.1' || parsed.username || parsed.password)
      throw new Error('A dedicated loopback replica set is required.');
  }
  const config = parseCloudConfig({
    NODE_ENV: 'test',
    MONGODB_URI: mongoUri ?? 'mongodb://unused',
    CLOUD_MONGODB_DATABASE: `harness_ci_${randomUUID().replaceAll('-', '')}`,
    CLOUD_TOKEN_PEPPER: 'p'.repeat(32),
    CLOUD_WORKSPACE_ROOT: path.join(root, 'workspaces'),
    CLOUD_INTERNAL_API_ENABLED: 'true',
    CLOUD_EXPERIMENTAL_CLAUDE_CLI: 'true',
    CLOUD_MODEL_BROKER_POLICIES_FILE: policiesFile,
    CLOUD_RUN_LEASE_MS: '60000',
    CLOUD_ATTEMPT_RECOVERY_MS: '60000',
  });
  const mongo = mongoUri ? new MongoService(config) : undefined;
  if (mongo) {
    await mongo.onModuleInit();
    await mongo.syncIndexes();
    cleanup.push(() => mongo.onModuleDestroy());
  }
  const store = mongo ? new MongoControlPlaneStore(mongo) : new MemoryControlPlaneStore();
  const received: Array<{
    apiKey: string | string[] | undefined;
    version: string | string[] | undefined;
    body: unknown;
  }> = [];
  let grantEcho = '';
  let closed = false;
  const upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received.push({
      apiKey: request.headers['x-api-key'],
      version: request.headers['anthropic-version'],
      body: JSON.parse(Buffer.concat(chunks).toString()),
    });
    if (mode === 'error') {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: secret }));
      return;
    }
    if (mode === 'json') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ text: 'OK' }));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (mode === 'stream') {
      response.write(`data: ${secret.slice(0, 7)}`);
      setTimeout(() => response.end(`${secret.slice(7)} ${grantEcho}\n\n`), 10);
    } else {
      const timer = setInterval(() => response.write(`data: ${'x'.repeat(256)}\n\n`), 25);
      response.once('close', () => {
        clearInterval(timer);
        closed = true;
      });
    }
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });
  const upstreamOrigin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  const module = await Test.createTestingModule({
    controllers: [ModelBrokerController],
    providers: [
      { provide: CLOUD_CONFIG, useValue: config },
      { provide: CONTROL_PLANE_STORE, useValue: store },
      {
        provide: MODEL_TRANSPORT,
        useValue: (url: string, options: RequestInit) => {
          expect(url).toBe('https://api.anthropic.com/v1/messages');
          return fetch(upstreamOrigin, options);
        },
      },
      AuthService,
      AuditService,
      WorkspaceService,
      ControlPlaneService,
      ExecutionGrantService,
      ModelBrokerService,
    ],
  }).compile();
  const app = module.createNestApplication({ bodyParser: false });
  const context = new RequestContextMiddleware();
  app.use((request, response, next) => context.use(request, response, next));
  app.use(json({ limit: MAX_MODEL_REQUEST_BYTES }));
  app.useGlobalFilters(new CloudExceptionFilter());
  await app.listen(0, '127.0.0.1');
  cleanup.push(() => app.close());
  const control = module.get(ControlPlaneService);
  const grants = module.get(ExecutionGrantService);
  const workspaces = module.get(WorkspaceService);
  const createRun = async (owner: TenantPrincipal) => {
    const workspace = await workspaces.prepareSnapshot(owner, {
      manifest: { schemaVersion: 1, entries: [] },
      files: [],
    });
    const session = await control.createSession(owner, { adapterId: CLAUDE_ADAPTER_ID });
    const { run } = await control.createRun(owner, session.sessionId, {
      prompt: 'Run prompt',
      workspace: workspace.source,
      permissionPolicy: 'read-only',
      model: { adapterId: CLAUDE_ADAPTER_ID, modelId: model },
    });
    await store.insertRunAttempt({
      organizationId: owner.organizationId,
      runId: run.runId,
      attempt: 1,
      queueJobId: randomUUID(),
      status: 'queued',
      active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const record = (await store.findRun(owner.organizationId, run.runId))!;
    const issued = await grants.issue(record);
    await grants.claim(issued.executionGrant, 'test-worker');
    return { run, issued };
  };
  const { run, issued } = await createRun(principal);
  grantEcho = issued.executionGrant;
  const url = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}/internal/v1/runs/${run.runId}/model?attempt=1`;
  const headers = {
    authorization: `Bearer ${issued.executionGrant}`,
    'x-worker-id': 'test-worker',
    'content-type': 'application/json',
  };
  return {
    config,
    mongo,
    store,
    principal,
    control,
    grants,
    run,
    issued,
    keyFile,
    url,
    headers,
    received,
    createRun,
    wasClosed: () => closed,
    resetClosed: () => {
      closed = false;
    },
    request: (body: unknown = requestBody, extra: Record<string, string> = {}) =>
      fetch(url, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) }),
  };
}
