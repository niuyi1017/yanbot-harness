import type {
  AuditRecord,
  DeviceRecord,
  EventRecord,
  ExecutionGrantRecord,
  InteractionRecord,
  MembershipRecord,
  OrganizationRecord,
  OutboxRecord,
  RunRecord,
  RunAttemptRecord,
  SessionRecord,
  TokenGrantRecord,
  UserRecord,
  WorkspaceRecord,
} from '../domain.js';
import type { WorkspaceSource } from '@yanbot-harness/contracts';
import type { ControlPlaneStore } from './control-plane.store.js';

export class MemoryControlPlaneStore implements ControlPlaneStore {
  readonly organizations = new Map<string, OrganizationRecord>();
  readonly users = new Map<string, UserRecord>();
  readonly memberships = new Map<string, MembershipRecord>();
  readonly devices = new Map<string, DeviceRecord>();
  readonly tokens: TokenGrantRecord[] = [];
  readonly audits: AuditRecord[] = [];
  readonly workspaces = new Map<string, WorkspaceRecord>();
  readonly sessions = new Map<string, SessionRecord>();
  readonly runs = new Map<string, RunRecord>();
  readonly events: EventRecord[] = [];
  readonly interactions = new Map<string, InteractionRecord>();
  readonly outbox: OutboxRecord[] = [];
  readonly runAttempts: RunAttemptRecord[] = [];
  readonly executionGrants: ExecutionGrantRecord[] = [];

  async transaction<T>(operation: () => Promise<T>): Promise<T> {
    return operation();
  }

  async provisionIdentity(input: {
    organization: OrganizationRecord;
    user: UserRecord;
    membership: MembershipRecord;
    device: DeviceRecord;
  }): Promise<'created' | 'existing'> {
    const key = tenantKey(input.device.organizationId, input.device.deviceId);
    if (this.devices.has(key)) return 'existing';
    this.organizations.set(input.organization.organizationId, clone(input.organization));
    this.users.set(input.user.userId, clone(input.user));
    this.memberships.set(tenantKey(input.membership.organizationId, input.membership.userId), clone(input.membership));
    this.devices.set(key, clone(input.device));
    return 'created';
  }

  async findDevice(organizationId: string, deviceId: string): Promise<DeviceRecord | undefined> {
    return cloneOptional(this.devices.get(tenantKey(organizationId, deviceId)));
  }

  async resolveActivePrincipal(record: Pick<TokenGrantRecord, 'organizationId' | 'userId' | 'deviceId'>) {
    const organization = this.organizations.get(record.organizationId);
    const user = this.users.get(record.userId);
    const membership = this.memberships.get(tenantKey(record.organizationId, record.userId));
    const device = this.devices.get(tenantKey(record.organizationId, record.deviceId));
    if (!organization || !user || !membership || !device) return undefined;
    if ([organization.status, user.status, membership.status, device.status].some((status) => status !== 'active')) {
      return undefined;
    }
    return clone({ organization, user, membership, device });
  }

  async insertTokenGrant(record: TokenGrantRecord): Promise<void> {
    this.tokens.push(clone(record));
  }

  async findAccessGrant(accessDigest: string): Promise<TokenGrantRecord | undefined> {
    return cloneOptional(this.tokens.find((record) => record.accessDigest === accessDigest));
  }

  async findRefreshGrant(refreshDigest: string): Promise<TokenGrantRecord | undefined> {
    return cloneOptional(this.tokens.find((record) => record.refreshDigest === refreshDigest));
  }

  async markRefreshRotated(refreshDigest: string, rotatedAt: Date): Promise<boolean> {
    const record = this.tokens.find(
      (candidate) => candidate.refreshDigest === refreshDigest && !candidate.rotatedAt && !candidate.revokedAt,
    );
    if (!record) return false;
    record.rotatedAt = new Date(rotatedAt);
    return true;
  }

  async revokeTokenFamily(familyId: string, revokedAt: Date): Promise<void> {
    for (const record of this.tokens.filter((candidate) => candidate.familyId === familyId)) {
      record.revokedAt = new Date(revokedAt);
    }
  }

  async insertAudit(record: AuditRecord): Promise<void> {
    this.audits.push(clone(record));
  }

  async insertWorkspace(record: WorkspaceRecord): Promise<void> {
    this.workspaces.set(tenantKey(record.organizationId, record.workspaceRef), clone(record));
  }

  async findWorkspace(organizationId: string, workspaceRef: string): Promise<WorkspaceRecord | undefined> {
    return cloneOptional(this.workspaces.get(tenantKey(organizationId, workspaceRef)));
  }

  async findWorkspaceBySource(
    organizationId: string,
    source: Extract<WorkspaceSource, { kind: 'git-ref' }>,
  ): Promise<WorkspaceRecord | undefined> {
    return cloneOptional(
      [...this.workspaces.values()].find(
        (record) =>
          record.organizationId === organizationId && JSON.stringify(record.source) === JSON.stringify(source),
      ),
    );
  }

  async listExpiredWorkspaces(now: Date, limit: number): Promise<WorkspaceRecord[]> {
    return [...this.workspaces.values()]
      .filter((record) => record.status === 'ready' && record.expiresAt <= now)
      .slice(0, limit)
      .map(clone);
  }

  async markWorkspaceDeleted(organizationId: string, workspaceRef: string): Promise<boolean> {
    const record = this.workspaces.get(tenantKey(organizationId, workspaceRef));
    if (!record || record.status === 'deleted') return false;
    record.status = 'deleted';
    return true;
  }

  async insertSession(record: SessionRecord): Promise<void> {
    this.sessions.set(tenantKey(record.organizationId, record.value.sessionId), clone(record));
  }

  async listSessions(organizationId: string): Promise<SessionRecord[]> {
    return [...this.sessions.values()].filter((record) => record.organizationId === organizationId).map(clone);
  }

  async findSession(organizationId: string, sessionId: string): Promise<SessionRecord | undefined> {
    return cloneOptional(this.sessions.get(tenantKey(organizationId, sessionId)));
  }

  async replaceSession(record: SessionRecord): Promise<void> {
    await this.insertSession(record);
  }

  async insertRunAndOutbox(run: RunRecord, outbox: OutboxRecord, session: SessionRecord): Promise<void> {
    this.runs.set(tenantKey(run.organizationId, run.runId), clone(run));
    this.outbox.push(clone(outbox));
    await this.replaceSession(session);
  }

  async findRun(organizationId: string, runId: string): Promise<RunRecord | undefined> {
    return cloneOptional(this.runs.get(tenantKey(organizationId, runId)));
  }

  async findIdempotentRun(organizationId: string, sessionId: string, key: string): Promise<RunRecord | undefined> {
    return cloneOptional(
      [...this.runs.values()].find(
        (record) =>
          record.organizationId === organizationId && record.sessionId === sessionId && record.idempotencyKey === key,
      ),
    );
  }

  async replaceRunAndSession(run: RunRecord, session: SessionRecord): Promise<void> {
    this.runs.set(tenantKey(run.organizationId, run.runId), clone(run));
    await this.replaceSession(session);
  }

  async cancelOutbox(organizationId: string, runId: string): Promise<void> {
    for (const record of this.outbox.filter(
      (entry) => entry.organizationId === organizationId && entry.runId === runId,
    )) {
      record.status = 'cancelled';
    }
  }

  async claimDispatchOutbox(owner: string, now: Date, leaseExpiresAt: Date): Promise<OutboxRecord | undefined> {
    const record = this.outbox
      .filter(
        (candidate) =>
          candidate.availableAt <= now &&
          (candidate.status === 'pending' ||
            (candidate.status === 'publishing' &&
              candidate.leaseExpiresAt !== undefined &&
              candidate.leaseExpiresAt <= now)),
      )
      .sort((left, right) => left.availableAt.getTime() - right.availableAt.getTime())[0];
    if (!record) return undefined;
    record.status = 'publishing';
    record.leaseOwner = owner;
    record.leaseExpiresAt = new Date(leaseExpiresAt);
    return clone(record);
  }

  async findOutbox(organizationId: string, outboxId: string): Promise<OutboxRecord | undefined> {
    return cloneOptional(
      this.outbox.find((record) => record.organizationId === organizationId && record.outboxId === outboxId),
    );
  }

  async insertOutbox(record: OutboxRecord): Promise<void> {
    if (
      this.outbox.some(
        (candidate) => candidate.organizationId === record.organizationId && candidate.outboxId === record.outboxId,
      )
    ) {
      throw new Error('The outbox record already exists.');
    }
    this.outbox.push(clone(record));
  }

  async markOutboxPublished(
    organizationId: string,
    outboxId: string,
    owner: string,
    queueJobId: string,
    publishedAt: Date,
  ): Promise<boolean> {
    const record = this.outbox.find(
      (candidate) =>
        candidate.organizationId === organizationId &&
        candidate.outboxId === outboxId &&
        candidate.status === 'publishing' &&
        candidate.leaseOwner === owner,
    );
    if (!record) return false;
    record.status = 'published';
    record.queueJobId = queueJobId;
    record.publishedAt = new Date(publishedAt);
    delete record.leaseOwner;
    delete record.leaseExpiresAt;
    return true;
  }

  async releaseOutbox(organizationId: string, outboxId: string, owner: string, availableAt: Date): Promise<boolean> {
    const record = this.outbox.find(
      (candidate) =>
        candidate.organizationId === organizationId &&
        candidate.outboxId === outboxId &&
        candidate.status === 'publishing' &&
        candidate.leaseOwner === owner,
    );
    if (!record) return false;
    record.status = 'pending';
    record.availableAt = new Date(availableAt);
    delete record.leaseOwner;
    delete record.leaseExpiresAt;
    return true;
  }

  async insertRunAttempt(record: RunAttemptRecord): Promise<void> {
    if (
      this.runAttempts.some(
        (candidate) =>
          (candidate.organizationId === record.organizationId &&
            candidate.runId === record.runId &&
            candidate.attempt === record.attempt) ||
          candidate.queueJobId === record.queueJobId ||
          (candidate.organizationId === record.organizationId &&
            candidate.runId === record.runId &&
            candidate.active &&
            record.active),
      )
    ) {
      throw new Error('The Run attempt conflicts with an existing attempt.');
    }
    this.runAttempts.push(clone(record));
  }

  async findRunAttempt(organizationId: string, runId: string, attempt: number): Promise<RunAttemptRecord | undefined> {
    return cloneOptional(
      this.runAttempts.find(
        (record) => record.organizationId === organizationId && record.runId === runId && record.attempt === attempt,
      ),
    );
  }

  async replaceRunAttempt(record: RunAttemptRecord): Promise<void> {
    const index = this.runAttempts.findIndex(
      (candidate) =>
        candidate.organizationId === record.organizationId &&
        candidate.runId === record.runId &&
        candidate.attempt === record.attempt,
    );
    if (index < 0) throw new Error('The Run attempt does not exist.');
    this.runAttempts[index] = clone(record);
  }

  async claimRunAttempt(
    organizationId: string,
    runId: string,
    attempt: number,
    workerId: string,
    now: Date,
    leaseExpiresAt: Date,
  ): Promise<RunAttemptRecord | undefined> {
    const record = this.runAttempts.find(
      (candidate) =>
        candidate.organizationId === organizationId &&
        candidate.runId === runId &&
        candidate.attempt === attempt &&
        candidate.active &&
        candidate.status === 'queued',
    );
    if (!record) return undefined;
    record.status = 'leased';
    record.workerId = workerId;
    record.heartbeatAt = new Date(now);
    record.leaseExpiresAt = new Date(leaseExpiresAt);
    record.updatedAt = new Date(now);
    return clone(record);
  }

  async heartbeatRunAttempt(
    organizationId: string,
    runId: string,
    attempt: number,
    workerId: string,
    now: Date,
    leaseExpiresAt: Date,
  ): Promise<boolean> {
    const record = this.runAttempts.find(
      (candidate) =>
        candidate.organizationId === organizationId &&
        candidate.runId === runId &&
        candidate.attempt === attempt &&
        candidate.active &&
        candidate.status === 'leased' &&
        candidate.workerId === workerId &&
        candidate.leaseExpiresAt !== undefined &&
        candidate.leaseExpiresAt > now,
    );
    if (!record) return false;
    record.heartbeatAt = new Date(now);
    record.leaseExpiresAt = new Date(leaseExpiresAt);
    record.updatedAt = new Date(now);
    return true;
  }

  async listRecoverableRunAttempts(before: Date, limit: number): Promise<RunAttemptRecord[]> {
    return this.runAttempts
      .filter(
        (record) =>
          record.active &&
          ((record.status === 'leased' && record.leaseExpiresAt !== undefined && record.leaseExpiresAt <= before) ||
            ((record.status === 'dispatching' || record.status === 'queued') && record.updatedAt <= before)),
      )
      .slice(0, limit)
      .map(clone);
  }

  async insertEvent(record: EventRecord): Promise<void> {
    this.events.push(clone(record));
  }

  async listEvents(organizationId: string, runId: string, afterSequence: number): Promise<EventRecord[]> {
    return this.events
      .filter(
        (record) =>
          record.organizationId === organizationId && record.runId === runId && record.sequence > afterSequence,
      )
      .sort((left, right) => left.sequence - right.sequence)
      .map(clone);
  }

  async findEvent(organizationId: string, runId: string, eventId: string): Promise<EventRecord | undefined> {
    return cloneOptional(
      this.events.find(
        (record) => record.organizationId === organizationId && record.runId === runId && record.eventId === eventId,
      ),
    );
  }

  async findInteractionRequest(organizationId: string, requestId: string): Promise<EventRecord | undefined> {
    return cloneOptional(
      this.events.find(
        (record) =>
          record.organizationId === organizationId &&
          record.value.type === 'interaction.requested' &&
          record.value.payload.requestId === requestId,
      ),
    );
  }

  async insertInteraction(record: InteractionRecord): Promise<'created' | 'existing'> {
    const key = tenantKey(record.organizationId, record.requestId);
    if (this.interactions.has(key)) return 'existing';
    this.interactions.set(key, clone(record));
    return 'created';
  }

  async findInteraction(organizationId: string, requestId: string): Promise<InteractionRecord | undefined> {
    return cloneOptional(this.interactions.get(tenantKey(organizationId, requestId)));
  }

  async insertExecutionGrant(record: ExecutionGrantRecord): Promise<void> {
    this.executionGrants.push(clone(record));
  }

  async claimExecutionGrant(
    digest: string,
    workerId: string,
    claimedAt: Date,
  ): Promise<ExecutionGrantRecord | undefined> {
    const record = this.executionGrants.find(
      (candidate) =>
        candidate.digest === digest && !candidate.claimedAt && !candidate.revokedAt && candidate.expiresAt > claimedAt,
    );
    if (!record) return undefined;
    record.claimedAt = new Date(claimedAt);
    record.claimedBy = workerId;
    return clone(record);
  }

  async findExecutionGrant(digest: string): Promise<ExecutionGrantRecord | undefined> {
    return cloneOptional(this.executionGrants.find((record) => record.digest === digest));
  }

  async revokeRunGrants(organizationId: string, runId: string, revokedAt: Date): Promise<void> {
    for (const record of this.executionGrants.filter(
      (candidate) => candidate.organizationId === organizationId && candidate.runId === runId,
    )) {
      record.revokedAt = new Date(revokedAt);
    }
  }
}

function tenantKey(organizationId: string, id: string): string {
  return `${organizationId.length}:${organizationId}${id}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function cloneOptional<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : clone(value);
}
