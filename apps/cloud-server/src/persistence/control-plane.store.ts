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
  SessionRecord,
  TokenGrantRecord,
  UserRecord,
  WorkspaceRecord,
} from '../domain.js';
import type { WorkspaceSource } from '@yanbot-harness/contracts';

export const CONTROL_PLANE_STORE = Symbol('CONTROL_PLANE_STORE');

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
  insertRunAndOutbox(run: RunRecord, outbox: OutboxRecord, session: SessionRecord): Promise<void>;
  findRun(organizationId: string, runId: string): Promise<RunRecord | undefined>;
  findIdempotentRun(organizationId: string, sessionId: string, key: string): Promise<RunRecord | undefined>;
  replaceRunAndSession(run: RunRecord, session: SessionRecord): Promise<void>;
  cancelOutbox(organizationId: string, runId: string): Promise<void>;
  insertEvent(record: EventRecord): Promise<void>;
  listEvents(organizationId: string, runId: string, afterSequence: number): Promise<EventRecord[]>;
  findEvent(organizationId: string, runId: string, eventId: string): Promise<EventRecord | undefined>;
  findInteractionRequest(organizationId: string, requestId: string): Promise<EventRecord | undefined>;
  insertInteraction(record: InteractionRecord): Promise<'created' | 'existing'>;
  findInteraction(organizationId: string, requestId: string): Promise<InteractionRecord | undefined>;

  insertExecutionGrant(record: ExecutionGrantRecord): Promise<void>;
  claimExecutionGrant(digest: string, claimedAt: Date): Promise<ExecutionGrantRecord | undefined>;
  findExecutionGrant(digest: string): Promise<ExecutionGrantRecord | undefined>;
  revokeRunGrants(organizationId: string, runId: string, revokedAt: Date): Promise<void>;
}
