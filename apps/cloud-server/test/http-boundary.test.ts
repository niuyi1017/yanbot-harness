import { randomUUID } from 'node:crypto';

import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { HARNESS_PROTOCOL_VERSION } from '@yanbot-harness/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { AuditService } from '../src/audit/audit.service.js';
import { AuthController } from '../src/auth/auth.controller.js';
import { AccessTokenGuard } from '../src/auth/auth.guard.js';
import { AuthService } from '../src/auth/auth.service.js';
import { CloudExceptionFilter } from '../src/common/cloud-exception.filter.js';
import { RequestContextMiddleware } from '../src/common/request-context.js';
import type { CloudConfig } from '../src/config.js';
import { ControlPlaneController } from '../src/control-plane/control-plane.controller.js';
import { ControlPlaneService } from '../src/control-plane/control-plane.service.js';
import { ExecutionGrantController } from '../src/execution-grants/execution-grant.controller.js';
import { ExecutionGrantService } from '../src/execution-grants/execution-grant.service.js';
import { CONTROL_PLANE_STORE } from '../src/persistence/control-plane.store.js';
import { MemoryControlPlaneStore } from '../src/persistence/memory.store.js';
import { CLOUD_CONFIG } from '../src/persistence/mongo.service.js';
import { WorkspaceController } from '../src/workspaces/workspace.controller.js';
import { WorkspaceService } from '../src/workspaces/workspace.service.js';

const applications: INestApplication[] = [];
afterEach(async () => Promise.all(applications.splice(0).map((application) => application.close())));

describe('Cloud HTTP boundary', () => {
  it('authenticates public resources and replays durable terminal SSE through a claimed grant', async () => {
    const { application, origin, auth, store, grants } = await startApplication();
    applications.push(application);
    const identity = {
      organizationId: randomUUID(),
      organizationName: 'HTTP tenant',
      userId: randomUUID(),
      userDisplayName: 'HTTP user',
      deviceId: randomUUID(),
      roles: ['owner'],
    };
    const provisioned = await auth.provision(identity);
    const tokens = await post(origin, '/v1/auth/device/exchange', {
      organizationId: identity.organizationId,
      deviceId: identity.deviceId,
      deviceSecret: provisioned.deviceSecret,
    });
    const authorization = { authorization: `Bearer ${String(tokens.accessToken)}` };
    const prepared = await post(
      origin,
      '/v1/workspaces/git',
      { repository: 'https://github.com/example/repo.git', commit: 'a'.repeat(40) },
      authorization,
    );
    const session = await post(origin, '/v1/sessions', { adapterId: 'cn.yanbot.reference' }, authorization);
    const created = await post(
      origin,
      `/v1/sessions/${String(session.sessionId)}/runs`,
      { prompt: 'HTTP boundary', workspace: prepared.workspace },
      { ...authorization, 'idempotency-key': 'http-boundary' },
    );
    const run = created.run as { runId: string; sessionId: string };
    const record = await store.findRun(identity.organizationId, run.runId);
    const now = new Date();
    await store.insertRunAttempt({
      organizationId: identity.organizationId,
      runId: run.runId,
      attempt: 1,
      queueJobId: `run-${run.runId}-attempt-1`,
      status: 'queued',
      active: true,
      createdAt: now,
      updatedAt: now,
    });
    const issued = await grants.issue(record!);
    const accessTokenSubstitution = await fetch(`${origin}/internal/v1/runs/${run.runId}?attempt=1`, {
      headers: { authorization: `Bearer ${String(tokens.accessToken)}`, 'x-worker-id': 'http-worker' },
    });
    expect(accessTokenSubstitution.status).toBe(401);
    const executionAuthorization = {
      authorization: `Bearer ${issued.executionGrant}`,
      'x-worker-id': 'http-worker',
    };
    const claim = await fetch(`${origin}/internal/v1/execution-grants/claim`, {
      method: 'POST',
      headers: { ...executionAuthorization, 'content-type': 'application/json' },
      body: JSON.stringify({ workerId: 'http-worker' }),
    });
    expect(claim.status).toBe(201);
    const claimedRun = await fetch(`${origin}/internal/v1/runs/${run.runId}?attempt=1`, {
      headers: executionAuthorization,
    });
    expect(claimedRun.status).toBe(200);
    const wrongHeartbeat = await fetch(`${origin}/internal/v1/runs/${run.runId}/heartbeat?attempt=1`, {
      method: 'POST',
      headers: { ...executionAuthorization, 'content-type': 'application/json' },
      body: JSON.stringify({ workerId: 'wrong-worker' }),
    });
    expect(wrongHeartbeat.status).toBe(403);
    const heartbeat = await fetch(`${origin}/internal/v1/runs/${run.runId}/heartbeat?attempt=1`, {
      method: 'POST',
      headers: { ...executionAuthorization, 'content-type': 'application/json' },
      body: JSON.stringify({ workerId: 'http-worker' }),
    });
    expect(heartbeat.status).toBe(204);
    const started = adapterEvent(run, 1, 'run.started', { adapterId: 'cn.yanbot.reference' });
    const completed = adapterEvent(run, 2, 'run.completed', {});
    for (const event of [started, completed]) {
      const response = await fetch(`${origin}/internal/v1/runs/${run.runId}/events?attempt=1`, {
        method: 'POST',
        headers: { ...executionAuthorization, 'content-type': 'application/json' },
        body: JSON.stringify(event),
      });
      expect(response.status).toBe(201);
    }
    const replay = await fetch(`${origin}/v1/runs/${run.runId}/events?afterEventId=${started.eventId}`, {
      headers: authorization,
    });
    expect(replay.status).toBe(200);
    const text = await replay.text();
    expect(text).toContain(`id: ${completed.eventId}`);
    expect(text).toContain('event: run.completed');
    expect(text).not.toContain(issued.executionGrant);
    await expect(store.findRunAttempt(identity.organizationId, run.runId, 1)).resolves.toMatchObject({
      status: 'completed',
      active: false,
    });
    expect(store.audits.map((entry) => entry.action)).toEqual(
      expect.arrayContaining(['execution-grant.claim', 'run.heartbeat', 'run.terminal']),
    );
  });

  it('returns and audits the actual 429 admission rejection status', async () => {
    const { application, origin, auth, store } = await startApplication({ maxActiveRunsPerOrganization: 1 });
    applications.push(application);
    const identity = {
      organizationId: randomUUID(),
      organizationName: 'Limited tenant',
      userId: randomUUID(),
      userDisplayName: 'Limited user',
      deviceId: randomUUID(),
      roles: ['owner'],
    };
    const provisioned = await auth.provision(identity);
    const tokens = await post(origin, '/v1/auth/device/exchange', {
      organizationId: identity.organizationId,
      deviceId: identity.deviceId,
      deviceSecret: provisioned.deviceSecret,
    });
    const authorization = { authorization: `Bearer ${String(tokens.accessToken)}` };
    const prepared = await post(
      origin,
      '/v1/workspaces/git',
      { repository: 'https://github.com/example/repo.git', commit: 'a'.repeat(40) },
      authorization,
    );
    const sessions = await Promise.all([
      post(origin, '/v1/sessions', { adapterId: 'cn.yanbot.reference' }, authorization),
      post(origin, '/v1/sessions', { adapterId: 'cn.yanbot.reference' }, authorization),
    ]);
    await post(
      origin,
      `/v1/sessions/${String(sessions[0]!.sessionId)}/runs`,
      { prompt: 'accepted', workspace: prepared.workspace },
      authorization,
    );
    const rejected = await fetch(`${origin}/v1/sessions/${String(sessions[1]!.sessionId)}/runs`, {
      method: 'POST',
      headers: { ...authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'rejected', workspace: prepared.workspace }),
    });
    expect(rejected.status).toBe(429);
    await expect(rejected.json()).resolves.toMatchObject({
      error: { code: 'HARNESS_FAILED', retryable: true },
    });
    expect(store.audits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'run.admission.reject', status: 429, errorCode: 'ADMISSION_CONCURRENCY' }),
        expect.objectContaining({ action: 'run.create', status: 429, errorCode: 'ADMISSION_CONCURRENCY' }),
      ]),
    );
  });
});

async function startApplication(overrides: Partial<CloudConfig> = {}) {
  const store = new MemoryControlPlaneStore();
  const config: CloudConfig = {
    nodeEnv: 'test',
    host: '127.0.0.1',
    port: 0,
    trustProxy: false,
    tlsTerminated: false,
    mongodbUri: 'mongodb://unused',
    mongodbDatabase: 'test',
    tokenPepper: 'p'.repeat(32),
    workspaceRoot: '/tmp/unused-cloud-http-workspaces',
    accessTokenTtlSeconds: 900,
    refreshTokenTtlSeconds: 604_800,
    eventRetentionSeconds: 604_800,
    workspaceTtlSeconds: 86_400,
    gitAllowedHosts: ['github.com'],
    internalApiEnabled: true,
    relayEnabled: false,
    queueName: 'test-remote',
    relayIntervalMs: 500,
    relayLeaseMs: 15_000,
    runLeaseMs: 30_000,
    attemptRecoveryMs: 60_000,
    maxAttempts: 3,
    retryDelayMs: 1_000,
    runAllowedRoles: ['owner', 'admin'],
    allowedPermissionPolicies: ['interactive', 'read-only'],
    maxActiveRunsPerOrganization: 10,
    maxRunsPerUtcDay: 1_000,
    ...overrides,
  };
  const module = await Test.createTestingModule({
    controllers: [AuthController, WorkspaceController, ControlPlaneController, ExecutionGrantController],
    providers: [
      { provide: CLOUD_CONFIG, useValue: config },
      { provide: CONTROL_PLANE_STORE, useValue: store },
      AuthService,
      AuditService,
      AccessTokenGuard,
      WorkspaceService,
      ControlPlaneService,
      ExecutionGrantService,
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
    store,
    grants: module.get(ExecutionGrantService),
  };
}

async function post(
  origin: string,
  pathname: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const response = await fetch(`${origin}${pathname}`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(response.ok).toBe(true);
  return (await response.json()) as Record<string, unknown>;
}

function adapterEvent(
  run: { runId: string; sessionId: string },
  sequence: number,
  type: 'run.started' | 'run.completed',
  payload: Record<string, unknown>,
) {
  return {
    protocolVersion: HARNESS_PROTOCOL_VERSION,
    eventId: randomUUID(),
    runId: run.runId,
    sessionId: run.sessionId,
    sequence,
    timestamp: new Date().toISOString(),
    type,
    payload,
  };
}
