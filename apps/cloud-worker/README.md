# Yanbot Harness Cloud Worker

Independent Phase 4 Reference execution process. It consumes the BullMQ Remote queue, claims one short-lived execution
grant, fetches only that Run and workspace metadata through the Cloud Server internal API, executes the credential-free
Reference Adapter through `@yanbot-harness/core`, and posts ordered events back to the control plane. It has no MongoDB,
platform access token, vendor key, or public API dependency.

Required variables:

- `WORKER_REDIS_URL`, `WORKER_QUEUE_NAME` (default `yanbot-harness-remote`)
- `WORKER_INTERNAL_ORIGIN`, `WORKER_ID`
- `WORKER_SHARED_WORKSPACE_ROOT`, mounted read-only in a production topology
- optional bounded concurrency, heartbeat, interaction poll and Run timeout values; see `src/config.ts`

Production requires HTTPS for the internal origin and `rediss:` for Redis. Start MongoDB and Redis first, then Cloud
Server with its relay enabled, and finally one or more Workers:

```bash
pnpm --filter @yanbot-harness/cloud-worker build
pnpm --filter @yanbot-harness/cloud-worker start
```

Graceful `SIGINT`/`SIGTERM` stops new queue work and waits for BullMQ shutdown. An abrupt Worker loss is recovered by
the Cloud Server attempt lease reaper with a new attempt and new grant. `WORKER_TEST_SCENARIO` is accepted only under
`NODE_ENV=test`; it is not a deployment feature.

This process is a Reference Worker, not a security sandbox. Uploaded snapshots receive shared-root containment checks.
Git execution is deliberately rejected until the separate Docker/network sandbox phase. It must not be used to claim
production Remote CodeBuddy, multi-tenant host isolation, or Docker containment certification.
