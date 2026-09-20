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
    const issued = await grants.issue(record!);
    const executionAuthorization = { authorization: `Bearer ${issued.executionGrant}` };
    const claim = await fetch(`${origin}/internal/v1/execution-grants/claim`, {
      method: 'POST',
      headers: executionAuthorization,
    });
    expect(claim.status).toBe(201);
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
  });
});

async function startApplication() {
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
