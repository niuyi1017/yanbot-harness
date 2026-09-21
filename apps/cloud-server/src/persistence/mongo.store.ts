import { AsyncLocalStorage } from 'node:async_hooks';

import { Inject, Injectable } from '@nestjs/common';
import type { ClientSession, Model, QueryFilter, UpdateQuery } from 'mongoose';

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
import { MongoService } from './mongo.service.js';

type DocumentRecord = Record<string, unknown>;
type SessionOptions = { session?: ClientSession };

@Injectable()
export class MongoControlPlaneStore implements ControlPlaneStore {
  readonly #mongo: MongoService;
  readonly #sessions = new AsyncLocalStorage<ClientSession>();

  constructor(@Inject(MongoService) mongo: MongoService) {
    this.#mongo = mongo;
  }

  async transaction<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#sessions.getStore()) return operation();
    return this.#mongo.transaction((session) => this.#sessions.run(session, operation));
  }

  async provisionIdentity(input: {
    organization: OrganizationRecord;
    user: UserRecord;
    membership: MembershipRecord;
    device: DeviceRecord;
  }): Promise<'created' | 'existing'> {
    return this.transaction(async () => {
      if (
        await this.#findOne<DeviceRecord>('Device', {
          organizationId: input.device.organizationId,
          deviceId: input.device.deviceId,
        })
      ) {
        return 'existing';
      }
      await this.#upsert('Organization', { organizationId: input.organization.organizationId }, input.organization);
      await this.#upsert('User', { userId: input.user.userId }, input.user);
      await this.#upsert(
        'Membership',
        { organizationId: input.membership.organizationId, userId: input.membership.userId },
        input.membership,
      );
      await this.#insert('Device', input.device);
      return 'created';
    });
  }

  findDevice(organizationId: string, deviceId: string): Promise<DeviceRecord | undefined> {
    return this.#findOne('Device', { organizationId, deviceId });
  }

  async resolveActivePrincipal(record: Pick<TokenGrantRecord, 'organizationId' | 'userId' | 'deviceId'>) {
    const [organization, user, membership, device] = await Promise.all([
      this.#findOne<OrganizationRecord>('Organization', { organizationId: record.organizationId, status: 'active' }),
      this.#findOne<UserRecord>('User', { userId: record.userId, status: 'active' }),
      this.#findOne<MembershipRecord>('Membership', {
        organizationId: record.organizationId,
        userId: record.userId,
        status: 'active',
      }),
      this.#findOne<DeviceRecord>('Device', {
        organizationId: record.organizationId,
        userId: record.userId,
        deviceId: record.deviceId,
        status: 'active',
      }),
    ]);
    return organization && user && membership && device ? { organization, user, membership, device } : undefined;
  }

  insertTokenGrant(record: TokenGrantRecord): Promise<void> {
    return this.#insert('TokenGrant', record);
  }

  findAccessGrant(accessDigest: string): Promise<TokenGrantRecord | undefined> {
    return this.#findOne('TokenGrant', { accessDigest });
  }

  findRefreshGrant(refreshDigest: string): Promise<TokenGrantRecord | undefined> {
    return this.#findOne('TokenGrant', { refreshDigest });
  }

  async markRefreshRotated(refreshDigest: string, rotatedAt: Date): Promise<boolean> {
    const result = await this.#model('TokenGrant').updateOne(
      { refreshDigest, rotatedAt: { $exists: false }, revokedAt: { $exists: false } },
      { $set: { rotatedAt } },
      this.#options(),
    );
    return result.modifiedCount === 1;
  }

  async revokeTokenFamily(familyId: string, revokedAt: Date): Promise<void> {
    await this.#model('TokenGrant').updateMany({ familyId }, { $set: { revokedAt } }, this.#options());
  }

  insertAudit(record: AuditRecord): Promise<void> {
    return this.#insert('AuditLog', record);
  }

  insertWorkspace(record: WorkspaceRecord): Promise<void> {
    return this.#insert('Workspace', record);
  }

  findWorkspace(organizationId: string, workspaceRef: string): Promise<WorkspaceRecord | undefined> {
    return this.#findOne('Workspace', { organizationId, workspaceRef });
  }

  findWorkspaceBySource(
    organizationId: string,
    source: Extract<WorkspaceSource, { kind: 'git-ref' }>,
  ): Promise<WorkspaceRecord | undefined> {
    return this.#findOne('Workspace', {
      organizationId,
      'source.kind': 'git-ref',
      'source.repository': source.repository,
      'source.ref': source.ref,
    });
  }

  async listExpiredWorkspaces(now: Date, limit: number): Promise<WorkspaceRecord[]> {
    return this.#model('Workspace')
      .find({ status: 'ready', expiresAt: { $lte: now } }, null, this.#options())
      .sort({ expiresAt: 1 })
      .limit(limit)
      .lean()
      .exec()
      .then((records) => records.map((record) => clean<WorkspaceRecord>(record)));
  }

  async markWorkspaceDeleted(organizationId: string, workspaceRef: string): Promise<boolean> {
    const result = await this.#model('Workspace').updateOne(
      { organizationId, workspaceRef, status: { $ne: 'deleted' } },
      { $set: { status: 'deleted' } },
      this.#options(),
    );
    return result.modifiedCount === 1;
  }

  insertSession(record: SessionRecord): Promise<void> {
    return this.#insert('HarnessSession', { ...record, sessionId: record.value.sessionId });
  }

  async listSessions(organizationId: string): Promise<SessionRecord[]> {
    return this.#model('HarnessSession')
      .find({ organizationId }, null, this.#options())
      .sort({ 'value.createdAt': 1 })
      .lean()
      .exec()
      .then((records) => records.map((record) => clean<SessionRecord>(record)));
  }

  findSession(organizationId: string, sessionId: string): Promise<SessionRecord | undefined> {
    return this.#findOne('HarnessSession', { organizationId, sessionId });
  }

  async replaceSession(record: SessionRecord): Promise<void> {
    await this.#replace(
      'HarnessSession',
      { organizationId: record.organizationId, sessionId: record.value.sessionId },
      {
        ...record,
        sessionId: record.value.sessionId,
      },
    );
  }

  async insertRunAndOutbox(run: RunRecord, outbox: OutboxRecord, session: SessionRecord): Promise<void> {
    await this.#insert('HarnessRun', run);
    await this.#insert('Outbox', outbox);
    await this.replaceSession(session);
  }

  findRun(organizationId: string, runId: string): Promise<RunRecord | undefined> {
    return this.#findOne('HarnessRun', { organizationId, runId });
  }

  findIdempotentRun(organizationId: string, sessionId: string, key: string): Promise<RunRecord | undefined> {
    return this.#findOne('HarnessRun', { organizationId, sessionId, idempotencyKey: key });
  }

  async replaceRunAndSession(run: RunRecord, session: SessionRecord): Promise<void> {
    await this.#replace('HarnessRun', { organizationId: run.organizationId, runId: run.runId }, run);
    await this.replaceSession(session);
  }

  async cancelOutbox(organizationId: string, runId: string): Promise<void> {
    await this.#model('Outbox').updateMany(
      { organizationId, runId, status: 'pending' },
      { $set: { status: 'cancelled' } },
      this.#options(),
    );
  }

  async claimDispatchOutbox(owner: string, now: Date, leaseExpiresAt: Date): Promise<OutboxRecord | undefined> {
    const query = this.#model('Outbox').findOneAndUpdate(
      {
        availableAt: { $lte: now },
        $or: [{ status: 'pending' }, { status: 'publishing', leaseExpiresAt: { $lte: now } }],
      },
      { $set: { status: 'publishing', leaseOwner: owner, leaseExpiresAt } },
      { ...this.#options(), new: true, sort: { availableAt: 1, createdAt: 1 } },
    );
    return optionalClean<OutboxRecord>(await query.lean().exec());
  }

  findOutbox(organizationId: string, outboxId: string): Promise<OutboxRecord | undefined> {
    return this.#findOne('Outbox', { organizationId, outboxId });
  }

  insertOutbox(record: OutboxRecord): Promise<void> {
    return this.#insert('Outbox', record);
  }

  async markOutboxPublished(
    organizationId: string,
    outboxId: string,
    owner: string,
    queueJobId: string,
    publishedAt: Date,
  ): Promise<boolean> {
    const result = await this.#model('Outbox').updateOne(
      { organizationId, outboxId, status: 'publishing', leaseOwner: owner },
      {
        $set: { status: 'published', queueJobId, publishedAt },
        $unset: { leaseOwner: 1, leaseExpiresAt: 1 },
      },
      this.#options(),
    );
    return result.modifiedCount === 1;
  }

  async releaseOutbox(organizationId: string, outboxId: string, owner: string, availableAt: Date): Promise<boolean> {
    const result = await this.#model('Outbox').updateOne(
      { organizationId, outboxId, status: 'publishing', leaseOwner: owner },
      {
        $set: { status: 'pending', availableAt },
        $unset: { leaseOwner: 1, leaseExpiresAt: 1 },
      },
      this.#options(),
    );
    return result.modifiedCount === 1;
  }

  insertRunAttempt(record: RunAttemptRecord): Promise<void> {
    return this.#insert('RunAttempt', record);
  }

  findRunAttempt(organizationId: string, runId: string, attempt: number): Promise<RunAttemptRecord | undefined> {
    return this.#findOne('RunAttempt', { organizationId, runId, attempt });
  }

  replaceRunAttempt(record: RunAttemptRecord): Promise<void> {
    return this.#replace(
      'RunAttempt',
      { organizationId: record.organizationId, runId: record.runId, attempt: record.attempt },
      record,
    );
  }

  async claimRunAttempt(
    organizationId: string,
    runId: string,
    attempt: number,
    workerId: string,
    now: Date,
    leaseExpiresAt: Date,
  ): Promise<RunAttemptRecord | undefined> {
    const query = this.#model('RunAttempt').findOneAndUpdate(
      { organizationId, runId, attempt, active: true, status: 'queued' },
      {
        $set: {
          status: 'leased',
          workerId,
          heartbeatAt: now,
          leaseExpiresAt,
          updatedAt: now,
        },
      },
      { ...this.#options(), new: true },
    );
    return optionalClean<RunAttemptRecord>(await query.lean().exec());
  }

  async heartbeatRunAttempt(
    organizationId: string,
    runId: string,
    attempt: number,
    workerId: string,
    now: Date,
    leaseExpiresAt: Date,
  ): Promise<boolean> {
    const result = await this.#model('RunAttempt').updateOne(
      {
        organizationId,
        runId,
        attempt,
        active: true,
        status: 'leased',
        workerId,
        leaseExpiresAt: { $gt: now },
      },
      { $set: { heartbeatAt: now, leaseExpiresAt, updatedAt: now } },
      this.#options(),
    );
    return result.modifiedCount === 1;
  }

  async listRecoverableRunAttempts(before: Date, limit: number): Promise<RunAttemptRecord[]> {
    return this.#model('RunAttempt')
      .find(
        {
          active: true,
          $or: [
            { status: 'leased', leaseExpiresAt: { $lte: before } },
            { status: { $in: ['dispatching', 'queued'] }, updatedAt: { $lte: before } },
          ],
        },
        null,
        this.#options(),
      )
      .sort({ updatedAt: 1 })
      .limit(limit)
      .lean()
      .exec()
      .then((records) => records.map((record) => clean<RunAttemptRecord>(record)));
  }

  insertEvent(record: EventRecord): Promise<void> {
    return this.#insert('RunEvent', record);
  }

  async listEvents(organizationId: string, runId: string, afterSequence: number): Promise<EventRecord[]> {
    return this.#model('RunEvent')
      .find({ organizationId, runId, sequence: { $gt: afterSequence } }, null, this.#options())
      .sort({ sequence: 1 })
      .lean()
      .exec()
      .then((records) => records.map((record) => clean<EventRecord>(record)));
  }

  findEvent(organizationId: string, runId: string, eventId: string): Promise<EventRecord | undefined> {
    return this.#findOne('RunEvent', { organizationId, runId, eventId });
  }

  findInteractionRequest(organizationId: string, requestId: string): Promise<EventRecord | undefined> {
    return this.#findOne('RunEvent', {
      organizationId,
      'value.type': 'interaction.requested',
      'value.payload.requestId': requestId,
    });
  }

  async insertInteraction(record: InteractionRecord): Promise<'created' | 'existing'> {
    const result = await this.#model('Interaction').updateOne(
      { organizationId: record.organizationId, requestId: record.requestId },
      { $setOnInsert: record },
      { ...this.#options(), upsert: true },
    );
    return result.upsertedCount === 1 ? 'created' : 'existing';
  }

  findInteraction(organizationId: string, requestId: string): Promise<InteractionRecord | undefined> {
    return this.#findOne('Interaction', { organizationId, requestId });
  }

  insertExecutionGrant(record: ExecutionGrantRecord): Promise<void> {
    return this.#insert('ExecutionGrant', record);
  }

  async claimExecutionGrant(
    digest: string,
    workerId: string,
    claimedAt: Date,
  ): Promise<ExecutionGrantRecord | undefined> {
    const query = this.#model('ExecutionGrant').findOneAndUpdate(
      { digest, claimedAt: { $exists: false }, revokedAt: { $exists: false }, expiresAt: { $gt: claimedAt } },
      { $set: { claimedAt, claimedBy: workerId } },
      { ...this.#options(), new: true },
    );
    return optionalClean<ExecutionGrantRecord>(await query.lean().exec());
  }

  findExecutionGrant(digest: string): Promise<ExecutionGrantRecord | undefined> {
    return this.#findOne('ExecutionGrant', { digest });
  }

  async revokeRunGrants(organizationId: string, runId: string, revokedAt: Date): Promise<void> {
    await this.#model('ExecutionGrant').updateMany(
      { organizationId, runId, revokedAt: { $exists: false } },
      { $set: { revokedAt } },
      this.#options(),
    );
  }

  #model(name: string): Model<DocumentRecord> {
    return this.#mongo.model<DocumentRecord>(name);
  }

  async #findOne<T>(name: string, filter: QueryFilter<DocumentRecord>): Promise<T | undefined> {
    return optionalClean<T>(await this.#model(name).findOne(filter, null, this.#options()).lean().exec());
  }

  async #insert(name: string, value: object): Promise<void> {
    await this.#model(name).create([value], this.#options());
  }

  async #upsert(name: string, filter: QueryFilter<DocumentRecord>, value: object): Promise<void> {
    await this.#model(name).updateOne(filter, { $setOnInsert: value } as UpdateQuery<DocumentRecord>, {
      ...this.#options(),
      upsert: true,
    });
  }

  async #replace(name: string, filter: QueryFilter<DocumentRecord>, value: object): Promise<void> {
    const result = await this.#model(name).replaceOne(filter, value, this.#options());
    if (result.matchedCount !== 1) throw new Error('The persisted resource changed concurrently.');
  }

  #options(): SessionOptions {
    const session = this.#sessions.getStore();
    return session === undefined ? {} : { session };
  }
}

function optionalClean<T>(value: unknown): T | undefined {
  return value === null || value === undefined ? undefined : clean<T>(value);
}

function clean<T>(value: unknown): T {
  if (typeof value !== 'object' || value === null) throw new Error('MongoDB returned an invalid document.');
  const record = { ...(value as Record<string, unknown>) };
  delete record._id;
  return record as T;
}
