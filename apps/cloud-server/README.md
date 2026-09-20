# Yanbot Harness Cloud Server

Phase 4 NestJS control plane for the Remote Harness protocol. It persists identity, workspace, Session, Run, Event,
Interaction, outbox, execution-grant, and audit records in MongoDB. It does not run an Adapter: Runs stay `queued`
until the separately scoped Phase 5 Worker consumes the outbox.

Required environment includes `MONGODB_URI`, `CLOUD_TOKEN_PEPPER` (at least 32 characters), and a dedicated
`CLOUD_WORKSPACE_ROOT`. Production also requires both `CLOUD_TLS_TERMINATED=true` and `CLOUD_TRUST_PROXY=true` and
rejects requests not observed as HTTPS through the trusted proxy. `CLOUD_GIT_ALLOWED_HOSTS` is a comma-separated
hostname allowlist. Internal Worker endpoints remain closed unless `CLOUD_INTERNAL_API_ENABLED=true`.

Bootstrap one organization/user/device with the `CLOUD_PROVISION_*` variables after building:

```bash
pnpm --filter @yanbot-harness/cloud-server build
pnpm --filter @yanbot-harness/cloud-server provision
```

The command prints the device secret exactly once. Store it in a secret manager. Expired snapshot storage is cleaned
with `pnpm --filter @yanbot-harness/cloud-server cleanup:workspaces`; `CLOUD_CLEANUP_LIMIT` defaults to 100. Production
index reconciliation is an explicit deployment operation: `pnpm --filter @yanbot-harness/cloud-server sync:indexes`.
