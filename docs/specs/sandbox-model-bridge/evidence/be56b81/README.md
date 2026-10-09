# Sandbox model bridge evidence

Source: `be56b8187c6631e03898126c1e41ca7fedac4f17`.

- [Remote sandbox CI 37865860781](https://github.com/niuyi1017/yanbot-harness/actions/runs/37865860781): all 7 Worker E2E cases passed, zero skipped. Includes actual Docker, Mongo 8.0.32, Redis, Cloud HTTP, independent Worker and pinned Claude Code 2.1.284.
- New bridge cases verify an SDK Run completes with text through the Guest/Host channel and scoped Broker, and cancellation of an active model stream aborts the upstream connection.
- Existing actual Docker probe retains nonroot/read-only/resource/network-denied/isolation/cleanup and parent-death checks; immutable image digests are in `remote-sandbox.json`.
- [Mongo/Broker CI 37865860787](https://github.com/niuyi1017/yanbot-harness/actions/runs/37865860787): 26 passed, zero skipped, including grant scope, policy, redaction, atomic quota, leases and connection loss.
- Local channel tests: 13 passed. Existing/new Claude tests: 20 passed. Sandbox Docker unit tests: 12 passed. Worker tests: 12 passed.

The provider transport is a test-only synthetic Anthropic JSON/SSE fixture. It never contacts Anthropic; all keys are synthetic. CLI usage/cost output is computed from synthetic responses and is not billing evidence. This certifies the experimental transport path, not paid model behavior, CodeBuddy model transport, persistent sessions or production readiness.

## Fixes discovered during acceptance

The pinned CLI reports `terminal_reason=completed` on actual successful responses. The parser now accepts that value while retaining is_error/subtype/error-reason checks.
A failed stream now ACKs its last private frame before closing the HTTP consumer; overflow terminates the stream and cannot yield a successful completion.
The cancellation fixture emits SSE pings after its initial text to advance the broker's finite redaction tail without completing the model response.

## Final regression gates

All eight workflows passed on the fixed source; see `workflows.json`.

- [CI](https://github.com/niuyi1017/yanbot-harness/actions/runs/37865860870) — passed.
- [Unified local installation](https://github.com/niuyi1017/yanbot-harness/actions/runs/37865860844) — passed.
- [Remote Mongo persistence](https://github.com/niuyi1017/yanbot-harness/actions/runs/37865860787) — passed.
- [Remote sandbox containment](https://github.com/niuyi1017/yanbot-harness/actions/runs/37865860781) — passed.
- [Claude CLI experimental probe](https://github.com/niuyi1017/yanbot-harness/actions/runs/37865860661) — passed.
- [Native containment](https://github.com/niuyi1017/yanbot-harness/actions/runs/37865860855) — passed.
- [Dual Runtime Matrix Evidence](https://github.com/niuyi1017/yanbot-harness/actions/runs/37865860794) — passed.
- [Distribution mechanism probes](https://github.com/niuyi1017/yanbot-harness/actions/runs/37865860769) — passed.

Distribution run 37865860769 passed on attempt 2 after rerunning only its failed macOS job with the same source. On attempt 1 the archive probe failed and report upload then failed with GitHub ENOTFOUND, so the original probe report was unavailable; its precise failure cause is not asserted. Windows and Linux results were retained. No application code or acceptance threshold was changed for that rerun.
