# Full Remote path with real Mongo

Source `1386dbb4b2080789113dec7272a567c1a180e82f`.
[CI 37817684580](https://github.com/niuyi1017/yanbot-harness/actions/runs/37817684580).

- Five Worker E2E tests passed, zero skipped: SDK/HTTP/Redis/independent Worker with MongoControlPlaneStore and MongoDB 8.0.32.
- Reference success, interaction and cancellation; Claude CLI and CodeBuddy SDK both fail with the expected authentication error in actual Docker, with durable terminal state and inactive attempts.
- Actual Docker policy includes disabled persistent logs, non-root, read-only rootfs, resource limits, denied network, no host binds, snapshot isolation, cancellation, parent death and unstarted-container cleanup.
- Immutable container images, Mongo image digest, server version and source commit are recorded in the JSON/text reports.

No paid model calls were made. This is single-node CI persistence evidence, not production TLS, vendor egress, credentials, multi-node failover, session restoration or release certification.
