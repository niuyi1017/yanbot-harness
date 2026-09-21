import { Schema } from 'mongoose';

const strict = { strict: 'throw' as const, minimize: false, versionKey: false as const };
const identity = { type: String, required: true };
const date = { type: Date, required: true };

export const collectionNames = Object.freeze({
  organizations: 'yanbot_harness_organizations',
  users: 'yanbot_harness_users',
  memberships: 'yanbot_harness_memberships',
  devices: 'yanbot_harness_devices',
  tokenGrants: 'yanbot_harness_token_grants',
  sessions: 'yanbot_harness_sessions',
  runs: 'yanbot_harness_runs',
  runAttempts: 'yanbot_harness_run_attempts',
  runEvents: 'yanbot_harness_run_events',
  interactions: 'yanbot_harness_interactions',
  workspaces: 'yanbot_harness_workspaces',
  executionGrants: 'yanbot_harness_execution_grants',
  outbox: 'yanbot_harness_outbox',
  auditLogs: 'yanbot_harness_audit_logs',
  admissionStates: 'yanbot_harness_admission_states',
});

export const organizationSchema = new Schema(
  { organizationId: identity, name: identity, status: { type: String, enum: ['active', 'disabled'], required: true } },
  strict,
).index({ organizationId: 1 }, { unique: true });

export const userSchema = new Schema(
  { userId: identity, displayName: identity, status: { type: String, enum: ['active', 'disabled'], required: true } },
  strict,
).index({ userId: 1 }, { unique: true });

export const membershipSchema = new Schema(
  {
    organizationId: identity,
    userId: identity,
    roles: { type: [String], required: true },
    status: { type: String, enum: ['active', 'disabled'], required: true },
  },
  strict,
).index({ organizationId: 1, userId: 1 }, { unique: true });

export const deviceSchema = new Schema(
  {
    organizationId: identity,
    userId: identity,
    deviceId: identity,
    secretDigest: identity,
    status: { type: String, enum: ['active', 'disabled'], required: true },
    createdAt: date,
  },
  strict,
).index({ organizationId: 1, deviceId: 1 }, { unique: true });

export const tokenGrantSchema = new Schema(
  {
    organizationId: identity,
    userId: identity,
    deviceId: identity,
    familyId: identity,
    accessDigest: identity,
    refreshDigest: identity,
    accessExpiresAt: date,
    refreshExpiresAt: date,
    rotatedAt: Date,
    revokedAt: Date,
    createdAt: date,
  },
  strict,
)
  .index({ accessDigest: 1 }, { unique: true })
  .index({ refreshDigest: 1 }, { unique: true })
  .index({ familyId: 1 })
  .index({ refreshExpiresAt: 1 }, { expireAfterSeconds: 0 });

export const sessionSchema = tenantDocumentSchema({
  sessionId: identity,
  value: { type: Schema.Types.Mixed, required: true },
}).index({ organizationId: 1, sessionId: 1 }, { unique: true });
export const runSchema = tenantDocumentSchema({
  runId: identity,
  sessionId: identity,
  workspaceRef: identity,
  value: { type: Schema.Types.Mixed, required: true },
  inputFingerprint: identity,
  idempotencyKey: String,
  admissionReleasedAt: Date,
})
  .index({ organizationId: 1, runId: 1 }, { unique: true })
  .index({ organizationId: 1, sessionId: 1, idempotencyKey: 1 }, { unique: true, sparse: true });
export const runEventSchema = tenantDocumentSchema({
  runId: identity,
  eventId: identity,
  sequence: { type: Number, required: true },
  value: { type: Schema.Types.Mixed, required: true },
  expiresAt: date,
})
  .index({ organizationId: 1, runId: 1, sequence: 1 }, { unique: true })
  .index({ organizationId: 1, eventId: 1 }, { unique: true })
  .index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const interactionSchema = tenantDocumentSchema({
  runId: identity,
  requestId: identity,
  response: { type: Schema.Types.Mixed, required: true },
  expiresAt: date,
}).index({ organizationId: 1, requestId: 1 }, { unique: true });
export const workspaceSchema = tenantDocumentSchema({
  workspaceRef: identity,
  source: { type: Schema.Types.Mixed, required: true },
  digest: identity,
  storageKey: String,
  status: { type: String, enum: ['ready', 'expired', 'deleted'], required: true },
  createdAt: date,
  expiresAt: date,
}).index({ organizationId: 1, workspaceRef: 1 }, { unique: true });
export const executionGrantSchema = tenantDocumentSchema({
  runId: identity,
  workspaceRef: identity,
  attempt: { type: Number, required: true },
  digest: identity,
  actions: { type: [String], required: true },
  expiresAt: date,
  claimedAt: Date,
  claimedBy: String,
  revokedAt: Date,
})
  .index({ digest: 1 }, { unique: true })
  .index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const outboxSchema = tenantDocumentSchema({
  outboxId: identity,
  runId: identity,
  attempt: { type: Number, required: true },
  kind: identity,
  status: { type: String, enum: ['pending', 'publishing', 'published', 'cancelled'], required: true },
  availableAt: date,
  createdAt: date,
  leaseOwner: String,
  leaseExpiresAt: Date,
  queueJobId: String,
  publishedAt: Date,
})
  .index({ organizationId: 1, outboxId: 1 }, { unique: true })
  .index({ status: 1, availableAt: 1 })
  .index({ organizationId: 1, runId: 1, attempt: 1 }, { unique: true });
export const runAttemptSchema = tenantDocumentSchema({
  runId: identity,
  attempt: { type: Number, required: true },
  queueJobId: identity,
  status: {
    type: String,
    enum: ['dispatching', 'queued', 'leased', 'completed', 'failed', 'abandoned'],
    required: true,
  },
  active: { type: Boolean, required: true },
  workerId: String,
  heartbeatAt: Date,
  leaseExpiresAt: Date,
  failureCode: String,
  createdAt: date,
  updatedAt: date,
})
  .index({ organizationId: 1, runId: 1, attempt: 1 }, { unique: true })
  .index({ queueJobId: 1 }, { unique: true })
  .index({ organizationId: 1, runId: 1, active: 1 }, { unique: true, partialFilterExpression: { active: true } })
  .index({ active: 1, status: 1, leaseExpiresAt: 1, updatedAt: 1 });
export const auditLogSchema = new Schema(
  {
    timestamp: date,
    requestId: identity,
    organizationId: String,
    subjectId: String,
    deviceId: String,
    action: identity,
    resourceType: String,
    resourceId: String,
    outcome: { type: String, enum: ['succeeded', 'rejected', 'failed'], required: true },
    status: { type: Number, required: true },
    errorCode: String,
    expiresAt: date,
  },
  strict,
)
  .index({ organizationId: 1, timestamp: -1 })
  .index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const admissionStateSchema = new Schema(
  {
    organizationId: identity,
    activeRuns: { type: Number, required: true, min: 0 },
    admittedRuns: { type: Number, required: true, min: 0 },
    periodStart: date,
    activeLimit: { type: Number, required: true, min: 1 },
    periodLimit: { type: Number, required: true, min: 1 },
    updatedAt: date,
  },
  strict,
).index({ organizationId: 1 }, { unique: true });

export const modelDefinitions = Object.freeze([
  ['Organization', organizationSchema, collectionNames.organizations],
  ['User', userSchema, collectionNames.users],
  ['Membership', membershipSchema, collectionNames.memberships],
  ['Device', deviceSchema, collectionNames.devices],
  ['TokenGrant', tokenGrantSchema, collectionNames.tokenGrants],
  ['HarnessSession', sessionSchema, collectionNames.sessions],
  ['HarnessRun', runSchema, collectionNames.runs],
  ['RunAttempt', runAttemptSchema, collectionNames.runAttempts],
  ['RunEvent', runEventSchema, collectionNames.runEvents],
  ['Interaction', interactionSchema, collectionNames.interactions],
  ['Workspace', workspaceSchema, collectionNames.workspaces],
  ['ExecutionGrant', executionGrantSchema, collectionNames.executionGrants],
  ['Outbox', outboxSchema, collectionNames.outbox],
  ['AuditLog', auditLogSchema, collectionNames.auditLogs],
  ['AdmissionState', admissionStateSchema, collectionNames.admissionStates],
] as const);

function tenantDocumentSchema(fields: Record<string, unknown>): Schema {
  return new Schema({ organizationId: identity, userId: String, ...fields }, strict);
}
