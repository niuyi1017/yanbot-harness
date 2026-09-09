# Yanbot Harness Local Runtime

Portable companion process for the Yanbot Harness SDK and CLI.

```bash
./bin/yanbot-harness-runtime --reference
```

Reference mode requires no credential. CodeBuddy mode reads `CODEBUDDY_API_KEY` only from the Runtime process
environment; the certified China route also uses `CODEBUDDY_INTERNET_ENVIRONMENT=internal`. Never place the key in a
client request, command argument, descriptor, or repository file.

For deterministic acceptance only, `YANBOT_HARNESS_REFERENCE_SCENARIO` can select `text`, `permission`, `question`,
or `wait-for-cancel` while `--reference` is active. It has no effect on CodeBuddy mode.

The Runtime listens only on loopback and writes `runtime.json` with mode `0600` beneath
`YANBOT_HARNESS_STATE_DIR` (default `~/.yanbot-harness`). It deletes the descriptor on normal SIGINT/SIGTERM shutdown.
SDK/CLI clients receive only the Runtime origin and short-scope bearer token stored in that descriptor.

Use `--help` and `--version` without starting the server. Node `>=22.22.0 <23` is required. This Preview certifies
macOS arm64 and Linux x64; Windows is not yet certified.
