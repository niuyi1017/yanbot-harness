# Run model broker engineering evidence

Source `558c96262a6a278e92d7df8a961e37b8bbc8f31d`.
[CI 37863473565](https://github.com/niuyi1017/yanbot-harness/actions/runs/37863473565).

All 26 tests passed, zero skipped: 8 existing Mongo persistence cases, 10 broker policy/transport cases and 8 broker HTTP cases using the actual Mongo store.
The HTTP upstream runs only on loopback with synthetic credentials. Evidence covers grant scope, tenant policy, concurrent request reservation,
reconnected counters, JSON/SSE, split-chunk redaction, body/response limits, Run cancellation, client disconnection and expired leases.

This does not certify real Anthropic requests, billing, production TLS or Sandbox-to-Broker transport. Containers remain network-disabled.
Mongo server version, immutable image digest and source commit are included in this directory.

## Cross-platform probe cleanup regression

The first implementation run at `6d3e262` passed all 26 Mongo/broker cases, but the Windows Claude probe failed while removing its temporary executable (`EBUSY`) after the functional probe passed.
Commit `558c962` adds bounded removal retries and publishes the pass report only after successful cleanup.
[Claude probe CI 37863473466](https://github.com/niuyi1017/yanbot-harness/actions/runs/37863473466) passed on macOS arm64, Windows x64 and Linux x64; the three reports are included here.
These are real pinned CLI binaries without provider credentials, not paid model success.

## Final source regression gates

All eight workflows passed on this source commit; see `workflows.json`.

- [Remote Mongo persistence](https://github.com/niuyi1017/yanbot-harness/actions/runs/37863473565) — passed.
- [Native containment](https://github.com/niuyi1017/yanbot-harness/actions/runs/37863473543) — passed.
- [Claude CLI experimental probe](https://github.com/niuyi1017/yanbot-harness/actions/runs/37863473466) — passed.
- [Remote sandbox containment](https://github.com/niuyi1017/yanbot-harness/actions/runs/37863473523) — passed.
- [Dual Runtime Matrix Evidence](https://github.com/niuyi1017/yanbot-harness/actions/runs/37863473664) — passed.
- [Distribution mechanism probes](https://github.com/niuyi1017/yanbot-harness/actions/runs/37863473521) — passed.
- [CI](https://github.com/niuyi1017/yanbot-harness/actions/runs/37863473491) — passed.
- [Unified local installation](https://github.com/niuyi1017/yanbot-harness/actions/runs/37863473573) — passed.
