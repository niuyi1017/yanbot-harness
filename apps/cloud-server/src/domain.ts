import type { AdapterEvent, InteractionResponse, Run, Session, WorkspaceSource } from '@yanbot-harness/contracts';

export type EntityStatus = 'active' | 'disabled';
export type TenantPrincipal = {
  organizationId: string;
  userId: string;
  deviceId: string;
  roles: readonly string[];
};

export type OrganizationRecord = { organizationId: string; name: string; status: EntityStatus };
export type UserRecord = { userId: string; displayName: string; status: EntityStatus };
export type MembershipRecord = {
  organizationId: string;
  userId: string;
  roles: string[];
  status: EntityStatus;
};
export type DeviceRecord = {
  organizationId: string;
  userId: string;
  deviceId: string;
  secretDigest: string;
  status: EntityStatus;
  createdAt: Date;
};
export type TokenGrantRecord = {
  organizationId: string;
  userId: string;
  deviceId: string;
  familyId: string;
  accessDigest: string;
  refreshDigest: string;
  accessExpiresAt: Date;
  refreshExpiresAt: Date;
  createdAt: Date;
  rotatedAt?: Date;
  revokedAt?: Date;
};
export type WorkspaceRecord = {
  organizationId: string;
  userId: string;
  workspaceRef: string;
  source: WorkspaceSource;
  digest: string;
  storageKey?: string;
  status: 'ready' | 'expired' | 'deleted';
  createdAt: Date;
  expiresAt: Date;
};
export type SessionRecord = { organizationId: string; userId: string; value: Session };
export type RunRecord = {
  organizationId: string;
  userId: string;
  sessionId: string;
  runId: string;
  workspaceRef: string;
  value: Run;
  inputFingerprint: string;
  idempotencyKey?: string;
};
export type EventRecord = {
  organizationId: string;
  runId: string;
  eventId: string;
  sequence: number;
  value: AdapterEvent;
  expiresAt: Date;
};
export type InteractionRecord = {
  organizationId: string;
  runId: string;
  requestId: string;
  response: InteractionResponse;
  expiresAt: Date;
};
export type OutboxRecord = {
  organizationId: string;
  outboxId: string;
  runId: string;
  kind: 'run.requested';
  status: 'pending' | 'published' | 'cancelled';
  availableAt: Date;
  createdAt: Date;
};
export type ExecutionGrantAction = 'workspace.read' | 'events.append' | 'interaction.read' | 'run.complete';
export type ExecutionGrantRecord = {
  organizationId: string;
  runId: string;
  workspaceRef: string;
  attempt: number;
  digest: string;
  actions: ExecutionGrantAction[];
  expiresAt: Date;
  claimedAt?: Date;
  revokedAt?: Date;
};
export type AuditRecord = {
  timestamp: Date;
  requestId: string;
  organizationId?: string;
  subjectId?: string;
  deviceId?: string;
  action: string;
  resourceType?: string;
  resourceId?: string;
  outcome: 'succeeded' | 'rejected' | 'failed';
  status: number;
  errorCode?: string;
  expiresAt: Date;
};
