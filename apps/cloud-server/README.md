# Yanbot Harness Cloud Server

Phase 4 NestJS control plane for the Remote Harness protocol. It persists identity, workspace, Session, Run, Event,
Interaction, outbox, execution-grant, Run-attempt, and audit records in MongoDB. It never runs an Adapter in the API
process. The separate `cloud-worker` Reference process consumes Redis/BullMQ jobs and reports events through the
grant-scoped internal API.

Run creation is admitted before Run/outbox writes. `CLOUD_RUN_ALLOWED_ROLES` defaults to `owner,admin`,
`CLOUD_ALLOWED_PERMISSION_POLICIES` defaults to `interactive,read-only`,
`CLOUD_MAX_ACTIVE_RUNS_PER_ORGANIZATION` defaults to 10, and `CLOUD_MAX_RUNS_PER_UTC_DAY` defaults to 1000. These are
deployment protection limits, not billing, plan, credit, or token-usage accounting. Active capacity is released once
when a Run reaches any terminal state; an infrastructure attempt retry does not consume another daily admission.

Required environment includes `MONGODB_URI`, `CLOUD_TOKEN_PEPPER` (at least 32 characters), and a dedicated
`CLOUD_WORKSPACE_ROOT`. Production also requires both `CLOUD_TLS_TERMINATED=true` and `CLOUD_TRUST_PROXY=true` and
rejects requests not observed as HTTPS through the trusted proxy. `CLOUD_GIT_ALLOWED_HOSTS` is a comma-separated
hostname allowlist. Internal Worker endpoints remain closed unless `CLOUD_INTERNAL_API_ENABLED=true`.

The outbox relay is opt-in with `CLOUD_RELAY_ENABLED=true` and requires `CLOUD_REDIS_URL`; production requires
`rediss:`. `CLOUD_QUEUE_NAME` must match the Worker. Relay interval/lease, Run lease, stale-attempt recovery, retry
delay, and maximum attempts have bounded defaults in `src/config.ts`. Recommended startup order is MongoDB and Redis,
Cloud Server (including index reconciliation), then Worker. A lost Redis job or expired Worker lease is abandoned,
its grant revoked, and a new attempt issued; retry exhaustion writes one durable `run.failed` event.

Bootstrap one organization/user/device with the `CLOUD_PROVISION_*` variables after building:

```bash
pnpm --filter @yanbot-harness/cloud-server build
pnpm --filter @yanbot-harness/cloud-server provision
```

The command prints the device secret exactly once. Store it in a secret manager. Expired snapshot storage is cleaned
with `pnpm --filter @yanbot-harness/cloud-server cleanup:workspaces`; `CLOUD_CLEANUP_LIMIT` defaults to 100. Production
index reconciliation is an explicit deployment operation: `pnpm --filter @yanbot-harness/cloud-server sync:indexes`.
Admission repair is also explicit and bounded. After building, run
`pnpm --filter @yanbot-harness/cloud-server reconcile:admission` for a JSONL dry-run; set
`CLOUD_ADMISSION_RECONCILE_LIMIT` if the default 1000-state bound is unsuitable, inspect every drift, then rerun with
`--apply`. Apply only repairs `activeRuns`; it never lowers the current UTC day's `admittedRuns`.

For deployment, sync indexes and run admission reconciliation before opening new traffic. For rollback, stop new Run
creation first and preserve `yanbot_harness_admission_states`; deleting it would erase daily-admission evidence. When
returning to this version, dry-run reconciliation before applying any repair. The new collection and optional Run
release marker require no destructive migration.

Use the shutdown signal handled by Nest so the relay closes BullMQ/Redis cleanly. Redis loss is recoverable from Mongo
attempt/outbox state, but production readiness still requires Redis TLS/ACL and a real Mongo replica-set transaction
test; local temporary Redis and memory-store evidence do not replace those gates.
