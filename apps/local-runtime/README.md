# Yanbot Harness Local Runtime

Portable companion process for the Yanbot Harness SDK and CLI.

Portable artifacts are independently unpacked and launched. The `preview.3` development candidate also packages the
same implementation as signed platform payloads discovered through `@yanbot-harness/runtime`, normally installed by
`@yanbot-harness/local`. Default production trust is intentionally empty; these are not published releases. The Runtime
always remains a separate process and Node remains a prerequisite. IPC-managed mode handles parent disconnect and
bounded shutdown; complete escaped-descendant/Runtime-force-kill containment is not certified. Portable Daemon mode
retains its independent lifecycle. Existing frozen `preview.2` archives are not rebuilt by this change.

```bash
./bin/yanbot-harness-runtime --reference
```

Reference mode requires no credential. CodeBuddy mode accepts exactly one Runtime-only credential source:
`CODEBUDDY_API_KEY`, or `CODEBUDDY_API_KEY_FILE` pointing to a protected one-line UTF-8 file. On POSIX the file must
be mode `0600` or stricter; on Windows restrict its ACL to the current tester account. The certified China route also
uses `CODEBUDDY_INTERNET_ENVIRONMENT=internal`. Never place the key in a client request, command argument,
descriptor, release archive, or repository file.

For deterministic acceptance only, `YANBOT_HARNESS_REFERENCE_SCENARIO` can select `text`, `permission`, `question`,
or `wait-for-cancel` while `--reference` is active. It has no effect on CodeBuddy mode.

The Runtime listens only on loopback and writes `runtime.json` with mode `0600` beneath
`YANBOT_HARNESS_STATE_DIR` (default `~/.yanbot-harness`). It deletes the descriptor on normal SIGINT/SIGTERM shutdown.
SDK/CLI clients receive only the Runtime origin and short-scope bearer token stored in that descriptor.

Use `--help` and `--version` without starting the server. Node `>=22.22.0 <23` is required. This Preview certifies
macOS arm64 and Linux x64. Windows 10/11 x64 packaging is a candidate until its Reference CI and real CodeBuddy
release checks pass.
