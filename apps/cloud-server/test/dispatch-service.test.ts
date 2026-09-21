import { randomUUID } from 'node:crypto';

import type { RemoteRunJob } from '@yanbot-harness/cloud-queue';
import { describe, expect, it } from 'vitest';

import { AuditService } from '../src/audit/audit.service.js';
import { AuthService } from '../src/auth/auth.service.js';
import type { CloudConfig } from '../src/config.js';
import { ControlPlaneService } from '../src/control-plane/control-plane.service.js';
import { DispatchService, type DispatchQueue } from '../src/dispatch/dispatch.service.js';
import type { TenantPrincipal, WorkspaceRecord } from '../src/domain.js';
import { ExecutionGrantService } from '../src/execution-grants/execution-grant.service.js';
import { MemoryControlPlaneStore } from '../src/persistence/memory.store.js';
import { WorkspaceService } from '../src/workspaces/workspace.service.js';

describe('Remote dispatch relay', () => {
  it('publishes the minimal deterministic job and persists the attempt', async () => {
    const fixture = await setup();
    expect(await fixture.dispatch.dispatchOnce()).toBe(true);
    expect(fixture.queue.jobs.size).toBe(1);
    const [{ data, jobId }] = [...fixture.queue.jobs.values()];
    expect(jobId).toBe(`run-${fixture.runId}-attempt-1`);
    expect(Object.keys(data).sort()).toEqual(['attempt', 'executionGrant', 'runId', 'schemaVersion']);
    expect(JSON.stringify(data)).not.toContain('relay prompt');
    await expect(
      fixture.store.findRunAttempt(fixture.principal.organizationId, fixture.runId, 1),
    ).resolves.toMatchObject({ status: 'queued', active: true, queueJobId: jobId });
    expect(fixture.store.outbox[0]).toMatchObject({ status: 'published', queueJobId: jobId });
  });

  it('reconciles a crash after Redis add without issuing a duplicate job', async () => {
    const fixture = await setup({ retryDelayMs: 0 });
    fixture.queue.failAfterAdd = true;
    await fixture.dispatch.dispatchOnce();
    expect(fixture.queue.jobs.size).toBe(1);
    fixture.queue.failAfterAdd = false;
    await fixture.dispatch.dispatchOnce();
    expect(fixture.queue.jobs.size).toBe(1);
    expect(fixture.store.outbox[0]?.status).toBe('published');
    expect(fixture.store.runAttempts).toHaveLength(1);
    expect(fixture.store.runAttempts[0]?.status).toBe('queued');
  });

  it('abandons a missing job and fails closed when the retry budget is exhausted', async () => {
    const fixture = await setup({ maxAttempts: 1, retryDelayMs: 0 });
    fixture.queue.failBeforeAdd = true;
    await fixture.dispatch.dispatchOnce();
    fixture.queue.failBeforeAdd = false;
    await fixture.dispatch.dispatchOnce();
    await expect(fixture.controlPlane.getRun(fixture.principal, fixture.runId)).resolves.toMatchObject({
      status: 'failed',
      terminalEventType: 'run.failed',
    });
    expect(fixture.store.runAttempts[0]).toMatchObject({ active: false });
    await expect(fixture.store.findAdmissionState(fixture.principal.organizationId)).resolves.toMatchObject({
      activeRuns: 0,
    });
  });

  it('reaps an expired worker lease, removes the stale job and creates a new grant attempt', async () => {
    const fixture = await setup({ retryDelayMs: 0 });
    await fixture.dispatch.dispatchOnce();
    const first = fixture.store.runAttempts[0]!;
    await fixture.store.replaceRunAttempt({
      ...first,
      status: 'leased',
      workerId: 'crashed-worker',
      heartbeatAt: new Date(0),
      leaseExpiresAt: new Date(0),
      updatedAt: new Date(0),
    });
    expect(await fixture.dispatch.reapOnce()).toBe(1);
    expect(fixture.queue.jobs.has(first.queueJobId)).toBe(false);
    expect(fixture.store.runAttempts[0]).toMatchObject({ active: false, failureCode: 'LEASE_EXPIRED' });
    expect(fixture.store.outbox).toEqual(expect.arrayContaining([expect.objectContaining({ attempt: 2 })]));
    await fixture.dispatch.dispatchOnce();
    expect(fixture.store.runAttempts[1]).toMatchObject({ attempt: 2, status: 'queued', active: true });
  });

  it('rebuilds a lost Redis job as a new attempt without reusing the old raw grant', async () => {
    const fixture = await setup({ retryDelayMs: 0, attemptRecoveryMs: 1 });
    await fixture.dispatch.dispatchOnce();
    const first = fixture.store.runAttempts[0]!;
    fixture.queue.jobs.clear();
    await fixture.store.replaceRunAttempt({ ...first, updatedAt: new Date(0) });
    expect(await fixture.dispatch.reapOnce()).toBe(1);
    await fixture.dispatch.dispatchOnce();
    const jobs = [...fixture.queue.jobs.values()];
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.data.attempt).toBe(2);
    expect(fixture.store.executionGrants.map((grant) => grant.digest)).toHaveLength(2);
    expect(new Set(fixture.store.executionGrants.map((grant) => grant.digest)).size).toBe(2);
    expect(JSON.stringify(fixture.store)).not.toContain(jobs[0]?.data.executionGrant);
  });
});

class FakeQueue implements DispatchQueue {
  readonly jobs = new Map<string, { data: RemoteRunJob; jobId: string }>();
  failBeforeAdd = false;
  failAfterAdd = false;

  async add(_name: string, data: RemoteRunJob, options: { jobId: string }): Promise<void> {
    if (this.failBeforeAdd) throw new Error('Redis unavailable.');
    this.jobs.set(options.jobId, { data, jobId: options.jobId });
    if (this.failAfterAdd) throw new Error('Relay crashed after add.');
  }

  async getJob(jobId: string) {
    if (!this.jobs.has(jobId)) return undefined;
    return { remove: async () => void this.jobs.delete(jobId) };
  }

  async close(): Promise<void> {}
}

async function setup(overrides: Partial<CloudConfig> = {}) {
  const config: CloudConfig = {
    nodeEnv: 'test',
    host: '127.0.0.1',
    port: 0,
    trustProxy: false,
    tlsTerminated: false,
    mongodbUri: 'mongodb://unused',
    mongodbDatabase: 'test',
    tokenPepper: 'p'.repeat(32),
    workspaceRoot: '/tmp/unused-cloud-dispatch-workspaces',
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
    retryDelayMs: 1,
    runAllowedRoles: ['owner', 'admin'],
    allowedPermissionPolicies: ['interactive', 'read-only'],
    maxActiveRunsPerOrganization: 10,
    maxRunsPerUtcDay: 1_000,
    ...overrides,
  };
  const store = new MemoryControlPlaneStore();
  const workspaces = new WorkspaceService(store, config);
  const controlPlane = new ControlPlaneService(store, workspaces, config, new AuditService(store, config));
  const auth = new AuthService(store, config);
  const audit = new AuditService(store, config);
  const grants = new ExecutionGrantService(store, auth, controlPlane, config, audit);
  const queue = new FakeQueue();
  const dispatch = new DispatchService(store, grants, controlPlane, audit, config, queue);
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
    source: { kind: 'uploaded-snapshot', uploadId: randomUUID(), digest: `sha256:${'a'.repeat(64)}` },
    digest: `sha256:${'a'.repeat(64)}`,
    storageKey: `${principal.organizationId}/snapshot`,
    status: 'ready',
    createdAt: now,
    expiresAt: new Date(now.getTime() + 60_000),
  };
  workspace.source = { ...workspace.source, uploadId: workspace.workspaceRef };
  await store.insertWorkspace(workspace);
  const session = await controlPlane.createSession(principal, { adapterId: 'cn.yanbot.reference' });
  const created = await controlPlane.createRun(principal, session.sessionId, {
    prompt: 'relay prompt',
    workspace: workspace.source,
  });
  return { config, store, controlPlane, queue, dispatch, principal, runId: created.run.runId };
}
