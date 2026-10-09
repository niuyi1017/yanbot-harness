# Tasks

- [x] T0 Record scope and design before implementation; commit this specification.
- [x] T1 CLI login/status/logout, private credential store, serialized refresh, server family revocation. Files: CLI arguments/index/new auth modules; cloud auth service/controller. Verify CLI and auth tests including redirection, expiry, concurrent refresh and file protection.
- [ ] T2 Pinned Git workspace materialization. Files: cloud workspace service/new fetcher, Worker source handling. Verify actual pinned checkout, path/link/size/host rejection and remote execution.
- [ ] T3 Persistent Session checkpoint protocol/store and container reconstruction. Files: contracts, cloud persistence/execution, Worker, sandbox host/guest. Verify tenant isolation, resume, TTL and stale-worker fencing including Mongo transactions.
- [ ] T4 Tool protocol and full vendor interactions. Files: model Broker/channel, Claude CLI host/adapter and CodeBuddy adapter. Verify actual pinned vendor tools, permission allow/deny, questions, cancellation and resumed run against a synthetic upstream.
- [ ] T5 Production configuration and multiworker recovery. Files: server/worker config and deployment/preflight/tests. Verify TLS/ACL rejection, worker loss and recovery with fenced state.
- [ ] T6 Full checks and Docker/Mongo/vendor CI; archive evidence, update capability/support docs and remaining external acceptance gates; commit and push only scoped files.

Dependencies: T1/T2 independent; T3 before resumed tool acceptance; T4 before vendor production configuration; T6 after all development tasks. Partial completion must not be described as all four modes complete.
