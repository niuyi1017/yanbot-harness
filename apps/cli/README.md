# @yanbot-harness/cli

Node.js 22 command-line client for a Yanbot Harness Runtime.

```bash
yanbot-harness --version
yanbot-harness adapters --json
yanbot-harness run "Reply with a delivery check" --json --log-level silent
```

By default the CLI discovers the mode-0600 local Runtime descriptor. Use `--descriptor PATH`, or use `--runtime URL`
with `YANBOT_HARNESS_ACCESS_TOKEN`. There is deliberately no token or CodeBuddy key command-line option.

Commands are `run`, `adapters`, `models`, `sessions`, `run-status`, and `cancel`. `run --json` emits a
`cli.run-created` record followed by public Adapter events, one JSON value per stdout line; diagnostics remain on
stderr. In text mode a TTY can answer permission/question interactions. JSON/non-TTY mode returns exit code `11`
when caller interaction is required.

Exit codes: `0` success, `2` usage, `10` cancelled/timeout, `11` interaction/permission, `20` authentication, `30`
Adapter/upstream, `40` Runtime/network/protocol.

The CLI only depends on `@yanbot-harness/sdk`. It requires the separately delivered Runtime companion and never
imports an Adapter or vendor SDK.
