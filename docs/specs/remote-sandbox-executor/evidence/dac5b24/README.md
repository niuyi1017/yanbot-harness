# Linux Remote engineering evidence

Source `dac5b2441eeb74d5fb0dcd615ebce2767d2318ce`.
[CI run 37814307695](https://github.com/niuyi1017/yanbot-harness/actions/runs/37814307695).

- `remote-sandbox.json`: immutable images; real Reference conformance, Claude CLI no-key error, CodeBuddy SDK missing-key error; non-root, read-only rootfs, resource limits, denied network, snapshot transfer, concurrent isolation, cancellation, parent death and abandoned-create cleanup.
- `remote-worker-e2e.json`: 5/5 passed, none skipped; public SDK, real HTTP/Redis/independent Worker and Docker. Both vendor adapters reach persisted authentication failure.

No paid calls, production Mongo/TLS, vendor session recovery or model egress were tested. Images were not published.
Persistent Docker log suppression was added after this source and has its own subsequent CI gate.
