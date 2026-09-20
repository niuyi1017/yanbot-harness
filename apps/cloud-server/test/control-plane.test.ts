import { randomUUID } from 'node:crypto';

import { HARNESS_PROTOCOL_VERSION } from '@yanbot-harness/contracts';
import { describe, expect, it } from 'vitest';

import { AuthService } from '../src/auth/auth.service.js';
import { AuditService } from '../src/audit/audit.service.js';
import type { CloudConfig } from '../src/config.js';
import { ControlPlaneService } from '../src/control-plane/control-plane.service.js';
import type { TenantPrincipal, WorkspaceRecord } from '../src/domain.js';
import { ExecutionGrantService } from '../src/execution-grants/execution-grant.service.js';
import { MemoryControlPlaneStore } from '../src/persistence/memory.store.js';
import { WorkspaceService } from '../src/workspaces/workspace.service.js';

const config: CloudConfig = {
  nodeEnv: 'test',
  host: '127.0.0.1',
  port: 0,
  trustProxy: false,
  tlsTerminated: false,
  mongodbUri: 'mongodb://unused',
  mongodbDatabase: 'test',
  tokenPepper: 'p'.repeat(32),
  workspaceRoot: '/tmp/unused-cloud-workspaces',
  accessTokenTtlSeconds: 900,
  refreshTokenTtlSeconds: 604_800,
  eventRetentionSeconds: 604_800,
  workspaceTtlSeconds: 86_400,
  gitAllowedHosts: ['github.com'],
  internalApiEnabled: true,
};

describe('Cloud control plane', () => {
  it('isolates tenants and enforces idempotency plus the session write lock', async () => {
    const { service, store, principal, workspace } = await setup();
    const session = await service.createSession(principal, { adapterId: 'cn.yanbot.reference' });
    const input = { prompt: 'test', workspace: workspace.source };
    const first = await service.createRun(principal, session.sessionId, input, 'same-key');
    const reused = await service.createRun(principal, session.sessionId, input, 'same-key');
    expect(reused).toEqual({ run: first.run, reused: true });
    await expect(
      service.createRun(principal, session.sessionId, { ...input, prompt: 'changed' }, 'same-key'),
    ).rejects.toMatchObject({ status: 409 });
    await expect(service.createRun(principal, session.sessionId, input, 'another-key')).rejects.toMatchObject({
      status: 409,
    });
    await expect(service.getRun({ ...principal, organizationId: randomUUID() }, first.run.runId)).rejects.toMatchObject(
      { status: 404 },
    );
    expect(store.outbox).toHaveLength(1);
  });

  it('cancels once, persists a terminal event and resumes from an event cursor', async () => {
    const { service, principal, workspace } = await setup();
    const session = await service.createSession(principal, { adapterId: 'cn.yanbot.reference' });
    const created = await service.createRun(principal, session.sessionId, {
      prompt: 'test',
      workspace: workspace.source,
    });
    const cancelled = await service.cancelRun(principal, created.run.runId, 'user request');
    expect(cancelled).toMatchObject({ status: 'cancelled', terminalEventType: 'run.cancelled', lastSequence: 1 });
    const events = await service.listEvents(principal, created.run.runId);
    expect(events).toHaveLength(1);
    await expect(service.listEvents(principal, created.run.runId, events[0]!.eventId)).resolves.toEqual([]);
    await expect(service.cancelRun(principal, created.run.runId)).resolves.toEqual(cancelled);
  });
});

describe('Execution grants', () => {
  it('are stored as digests, claimed once and constrained by run, attempt and action', async () => {
    const { service, store, principal, workspace, auth } = await setup();
    const session = await service.createSession(principal, { adapterId: 'cn.yanbot.reference' });
    const created = await service.createRun(principal, session.sessionId, {
      prompt: 'test',
      workspace: workspace.source,
    });
    const record = await store.findRun(principal.organizationId, created.run.runId);
    expect(record).toBeDefined();
    const grants = new ExecutionGrantService(store, auth, service, config, new AuditService(store, config));
    const issued = await grants.issue(record!);
    expect(JSON.stringify(store)).not.toContain(issued.executionGrant);
    await expect(grants.claim(issued.executionGrant)).resolves.toMatchObject({ runId: created.run.runId, attempt: 1 });
    await expect(grants.claim(issued.executionGrant)).rejects.toMatchObject({ status: 403 });
    await expect(grants.workspace(issued.executionGrant, randomUUID(), 1)).rejects.toMatchObject({ status: 403 });
    await expect(grants.workspace(issued.executionGrant, created.run.runId, 2)).rejects.toMatchObject({ status: 403 });
  });

  it('appends contiguous events, rejects forged scope and closes a terminal run', async () => {
    const { service, store, principal, workspace, auth } = await setup();
    const session = await service.createSession(principal, { adapterId: 'cn.yanbot.reference' });
    const created = await service.createRun(principal, session.sessionId, {
      prompt: 'test',
      workspace: workspace.source,
    });
    const record = await store.findRun(principal.organizationId, created.run.runId);
    const grants = new ExecutionGrantService(store, auth, service, config, new AuditService(store, config));
    const issued = await grants.issue(record!);
    await grants.claim(issued.executionGrant);
    const started = event(created.run.runId, session.sessionId, 1, 'run.started', {
      adapterId: 'cn.yanbot.reference',
    });
    await expect(grants.append(issued.executionGrant, created.run.runId, 1, started)).resolves.toEqual(started);
    await expect(
      grants.append(issued.executionGrant, created.run.runId, 1, { ...started, eventId: randomUUID(), sequence: 3 }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      grants.append(issued.executionGrant, created.run.runId, 1, {
        ...started,
        eventId: randomUUID(),
        runId: randomUUID(),
        sequence: 2,
      }),
    ).rejects.toMatchObject({ status: 403 });
    const completed = event(created.run.runId, session.sessionId, 2, 'run.completed', {});
    await grants.append(issued.executionGrant, created.run.runId, 1, completed);
    await expect(
      grants.append(issued.executionGrant, created.run.runId, 1, { ...completed, eventId: randomUUID(), sequence: 3 }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(service.getRun(principal, created.run.runId)).resolves.toMatchObject({ status: 'completed' });
  });

  it('keeps the internal boundary closed by default', async () => {
    const { service, store, auth } = await setup();
    const disabledConfig = { ...config, internalApiEnabled: false };
    const grants = new ExecutionGrantService(
      store,
      auth,
      service,
      disabledConfig,
      new AuditService(store, disabledConfig),
    );
    await expect(grants.claim('yhe_' + 'x'.repeat(43))).rejects.toMatchObject({ status: 404 });
  });
});

async function setup() {
  const store = new MemoryControlPlaneStore();
  const workspaces = new WorkspaceService(store, config);
  const service = new ControlPlaneService(store, workspaces, config);
  const auth = new AuthService(store, config);
  const principal: TenantPrincipal = {
    organizationId: randomUUID(),
    userId: randomUUID(),
    deviceId: randomUUID(),
    roles: ['owner'],
  };
  const now = new Date();
  const workspace: WorkspaceRecord = {
    organizationId: principal.organizationId,
    userId: principal.userId,
    workspaceRef: randomUUID(),
    source: {
      kind: 'git-ref',
      repository: 'https://github.com/example/repo.git',
      ref: 'a'.repeat(40),
    },
    digest: `sha256:${'b'.repeat(64)}`,
    status: 'ready',
    createdAt: now,
    expiresAt: new Date(now.getTime() + 60_000),
  };
  await store.insertWorkspace(workspace);
  return { store, workspaces, service, auth, principal, workspace };
}

function event(
  runId: string,
  sessionId: string,
  sequence: number,
  type: 'run.started' | 'run.completed',
  payload: Record<string, unknown>,
) {
  return {
    protocolVersion: HARNESS_PROTOCOL_VERSION,
    eventId: randomUUID(),
    runId,
    sessionId,
    sequence,
    timestamp: new Date().toISOString(),
    type,
    payload,
  };
}
