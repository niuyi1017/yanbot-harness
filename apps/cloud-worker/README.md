# Yanbot Harness Cloud Worker

Independent Remote execution process. It consumes the BullMQ Remote queue, claims one short-lived execution
grant, fetches only that Run and workspace metadata through the Cloud Server internal API, executes the credential-free
Reference Adapter through `@yanbot-harness/core`, and posts ordered events back to the control plane. It has no MongoDB,
platform access token, vendor key, or public API dependency.

Required variables:

- `WORKER_REDIS_URL`, `WORKER_QUEUE_NAME` (default `yanbot-harness-remote`)
- `WORKER_INTERNAL_ORIGIN`, `WORKER_ID`
- `WORKER_SHARED_WORKSPACE_ROOT`, mounted read-only in a production topology
- optional bounded concurrency, heartbeat, interaction poll and Run timeout values; see `src/config.ts`

Production requires HTTPS for the internal origin and `rediss:` with a named ACL user and password for Redis. Start MongoDB and Redis first, then Cloud
Server with its relay enabled, and finally one or more Workers:

```bash
pnpm --filter @yanbot-harness/cloud-worker build
pnpm --filter @yanbot-harness/cloud-worker start
```

Graceful `SIGINT`/`SIGTERM` stops new queue work and waits for BullMQ shutdown. An abrupt Worker loss is recovered by
the Cloud Server attempt lease reaper: unstarted work may get a new attempt/grant; started work fails to avoid repeating side effects. `WORKER_TEST_SCENARIO` is accepted only under
`NODE_ENV=test`; it is not a deployment feature.

`WORKER_EXECUTION_MODE=sandbox` enables immutable Docker execution with `WORKER_DOCKER_PATH`, `WORKER_SANDBOX_IMAGE` and optional `WORKER_MODEL_BRIDGE_ENABLED=true`. Prepared Git workspaces require this mode. The isolated Guest receives bounded snapshots, never a host mount or model key. Successful runs checkpoint workspace/history before their terminal event; replacement Workers can restore them. See [production and recovery operations](../../docs/specs/four-mode-completion/operations.md) for configuration and evidence limits.
