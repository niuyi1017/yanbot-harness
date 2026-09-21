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

The host can set `YANBOT_HARNESS_EXTENSIONS_DIR` to an absolute, trusted directory before starting the Runtime (also
accepted by the packaged launcher and SDK managed runtime environment). It may contain `skills/<name>/SKILL.md` and
`mcp.json`. This is host configuration, never a Run request field; SDK clients discover `/v1/extensions` then select
IDs and optional versions through the ordinary Run extensions list. No source imports or vendor SDK are required.
Only files selected by a run become private bounded UTF-8 snapshots. Per-run extension config must currently be empty.
Changing registered metadata requires a Runtime restart; changing any effective content invalidates session resume.

Example trusted `mcp.json` (use a fully qualified Node executable and script path on the deployment machine):

```json
{ "mcpServers": { "demo": { "command": "node", "args": ["demo-mcp.js"] } } }
```

MCP execution initially allows stdio only. Shell interpreters and `.cmd`/`.bat` launchers, literal `env`, and unknown
fields are rejected. Credential-aware embedders may use `envCredentialRefs` plus the Runtime's trusted configuration
and context provider; standalone registration intentionally supplies no extension credentials. Reference capabilities
are explicitly emulated and never start the configured command. CodeBuddy extension execution remains gated until
its independent live verification passes. Private digest pins survive Runtime restarts and never appear in API sessions.

The Runtime listens only on loopback and writes `runtime.json` with mode `0600` beneath
`YANBOT_HARNESS_STATE_DIR` (default `~/.yanbot-harness`). It deletes the descriptor on normal SIGINT/SIGTERM shutdown.
SDK/CLI clients receive only the Runtime origin and short-scope bearer token stored in that descriptor.

Use `--help` and `--version` without starting the server. Node `>=22.22.0 <23` is required. This Preview certifies
macOS arm64 and Linux x64. Windows 10/11 x64 packaging is a candidate until its Reference CI and real CodeBuddy
release checks pass.
