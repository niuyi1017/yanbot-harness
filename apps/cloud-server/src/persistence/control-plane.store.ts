import type {
  AdmissionStateRecord,
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

export const CONTROL_PLANE_STORE = Symbol('CONTROL_PLANE_STORE');

export type AdmissionLimits = {
  activeLimit: number;
  periodLimit: number;
  periodStart: Date;
  now: Date;
};

export type AdmissionResult = 'created' | 'concurrency' | 'quota';

export interface ControlPlaneStore {
  transaction<T>(operation: () => Promise<T>): Promise<T>;
  provisionIdentity(input: {
    organization: OrganizationRecord;
    user: UserRecord;
    membership: MembershipRecord;
    device: DeviceRecord;
  }): Promise<'created' | 'existing'>;
  findDevice(organizationId: string, deviceId: string): Promise<DeviceRecord | undefined>;
  resolveActivePrincipal(record: Pick<TokenGrantRecord, 'organizationId' | 'userId' | 'deviceId'>): Promise<
    | {
        organization: OrganizationRecord;
        user: UserRecord;
        membership: MembershipRecord;
        device: DeviceRecord;
      }
    | undefined
  >;
  insertTokenGrant(record: TokenGrantRecord): Promise<void>;
  findAccessGrant(accessDigest: string): Promise<TokenGrantRecord | undefined>;
  findRefreshGrant(refreshDigest: string): Promise<TokenGrantRecord | undefined>;
  markRefreshRotated(refreshDigest: string, rotatedAt: Date): Promise<boolean>;
  revokeTokenFamily(familyId: string, revokedAt: Date): Promise<void>;
  insertAudit(record: AuditRecord): Promise<void>;

  insertWorkspace(record: WorkspaceRecord): Promise<void>;
  findWorkspace(organizationId: string, workspaceRef: string): Promise<WorkspaceRecord | undefined>;
  findWorkspaceBySource(
    organizationId: string,
    source: Extract<WorkspaceSource, { kind: 'git-ref' }>,
  ): Promise<WorkspaceRecord | undefined>;
  listExpiredWorkspaces(now: Date, limit: number): Promise<WorkspaceRecord[]>;
  markWorkspaceDeleted(organizationId: string, workspaceRef: string): Promise<boolean>;

  insertSession(record: SessionRecord): Promise<void>;
  listSessions(organizationId: string): Promise<SessionRecord[]>;
  findSession(organizationId: string, sessionId: string): Promise<SessionRecord | undefined>;
  replaceSession(record: SessionRecord): Promise<void>;
  insertAdmittedRunAndOutbox(
    run: RunRecord,
    outbox: OutboxRecord,
    session: SessionRecord,
    limits: AdmissionLimits,
  ): Promise<AdmissionResult>;
  releaseRunAdmission(organizationId: string, runId: string, releasedAt: Date): Promise<boolean>;
  findAdmissionState(organizationId: string): Promise<AdmissionStateRecord | undefined>;
  listAdmissionStates(limit: number): Promise<AdmissionStateRecord[]>;
  countActiveRuns(organizationId: string): Promise<number>;
  reconcileAdmissionActiveRuns(
    organizationId: string,
    previousActiveRuns: number,
    activeRuns: number,
    updatedAt: Date,
  ): Promise<boolean>;
  findRun(organizationId: string, runId: string): Promise<RunRecord | undefined>;
  findIdempotentRun(organizationId: string, sessionId: string, key: string): Promise<RunRecord | undefined>;
  replaceRunAndSession(run: RunRecord, session: SessionRecord): Promise<void>;
  cancelOutbox(organizationId: string, runId: string): Promise<void>;
  cancelOutboxRecord(organizationId: string, outboxId: string, owner: string): Promise<boolean>;
  claimDispatchOutbox(owner: string, now: Date, leaseExpiresAt: Date): Promise<OutboxRecord | undefined>;
  findOutbox(organizationId: string, outboxId: string): Promise<OutboxRecord | undefined>;
  insertOutbox(record: OutboxRecord): Promise<void>;
  markOutboxPublished(
    organizationId: string,
    outboxId: string,
    owner: string,
    queueJobId: string,
    publishedAt: Date,
  ): Promise<boolean>;
  releaseOutbox(organizationId: string, outboxId: string, owner: string, availableAt: Date): Promise<boolean>;
  insertRunAttempt(record: RunAttemptRecord): Promise<void>;
  findRunAttempt(organizationId: string, runId: string, attempt: number): Promise<RunAttemptRecord | undefined>;
  replaceRunAttempt(record: RunAttemptRecord): Promise<void>;
  claimRunAttempt(
    organizationId: string,
    runId: string,
    attempt: number,
    workerId: string,
    now: Date,
    leaseExpiresAt: Date,
  ): Promise<RunAttemptRecord | undefined>;
  heartbeatRunAttempt(
    organizationId: string,
    runId: string,
    attempt: number,
    workerId: string,
    now: Date,
    leaseExpiresAt: Date,
  ): Promise<boolean>;
  listRecoverableRunAttempts(now: Date, staleBefore: Date, limit: number): Promise<RunAttemptRecord[]>;
  closeRunAttempt(
    organizationId: string,
    runId: string,
    attempt: number,
    status: Extract<RunAttemptRecord['status'], 'completed' | 'failed' | 'abandoned'>,
    updatedAt: Date,
    failureCode?: string,
    workerId?: string,
  ): Promise<boolean>;
  closeActiveRunAttempts(
    organizationId: string,
    runId: string,
    status: Extract<RunAttemptRecord['status'], 'completed' | 'failed' | 'abandoned'>,
    updatedAt: Date,
    failureCode?: string,
  ): Promise<number>;
  insertEvent(record: EventRecord): Promise<void>;
  listEvents(organizationId: string, runId: string, afterSequence: number): Promise<EventRecord[]>;
  findEvent(organizationId: string, runId: string, eventId: string): Promise<EventRecord | undefined>;
  findInteractionRequest(organizationId: string, requestId: string): Promise<EventRecord | undefined>;
  insertInteraction(record: InteractionRecord): Promise<'created' | 'existing'>;
  findInteraction(organizationId: string, requestId: string): Promise<InteractionRecord | undefined>;

  insertExecutionGrant(record: ExecutionGrantRecord): Promise<void>;
  claimExecutionGrantAndAttempt(
    digest: string,
    workerId: string,
    claimedAt: Date,
    leaseExpiresAt: Date,
  ): Promise<ExecutionGrantRecord | undefined>;
  claimExecutionGrant(digest: string, workerId: string, claimedAt: Date): Promise<ExecutionGrantRecord | undefined>;
  findExecutionGrant(digest: string): Promise<ExecutionGrantRecord | undefined>;
  revokeRunGrants(organizationId: string, runId: string, revokedAt: Date): Promise<void>;
}
