# CodeBuddy extension candidate evidence

Status: implementation candidate, not R0/R1 certification. Default launcher extension capabilities remain unsupported.
Host-only `--experimental-extensions` or `YANBOT_HARNESS_EXPERIMENTAL_EXTENSIONS=1` exposes candidate native execution
with `limits.experimental=true` and `limits.liveVerified=false`. A Renderer Run request cannot enable it.

## Pinned SDK review

Reviewed installed SDK `0.3.254`, without patching or calling vendor private APIs:

- Public `Options.mcpServers`, `strictMcpConfig`, `tools`, `settingSources`, `env` and `maxBudgetUsd` exist.
- `lib/transport/process-transport.js` passes MCP object settings as CLI JSON argv. Therefore raw credentials must not
  be inserted there. Candidate bindings use generated environment placeholders and private child environment values.
- Vendor `mcp-config-env-expand-service.d.ts` explicitly documents stdio env `${VAR_NAME}` expansion.
- Vendor `SkillProductProvider.loadSkills` scans project/user/connector/session/builtin roots independently of setting
  sources. Candidate execution rejects ambient project configuration, uses a private session config directory and
  disposable `CODEBUDDY_SESSION_SKILL_DIRS`, clears builtin roots, and enables no filesystem setting source.
- Session config storage retains vendor transcripts for resume. Run projection files and exclusive lease are cleaned
  before terminal events are exposed. A crash-stale lease fails closed; automatic crash recovery remains unverified.

## Offline verification

CodeBuddy Adapter: 26 tests passed, including 8 candidate tests. Covers default rejection, experimental metadata,
secret-free argv placeholders, credential resolution failure, portable selected projection, ambient configuration
rejection, transcript retention, concurrent-session rejection, query failure, cancellation, redaction and cleanup.
Existing permission/question, timeout and terminal tests also passed. Targeted ESLint and package build passed.

Only Read/Skill/AskUserQuestion built-in tools are exposed for extension candidates. Business effects must use selected
MCP tools. MCP stdio only; raw command/argv environment interpolation is rejected. No source path or resolved secret
is added to public protocol fields.

## Live and platform gates

Run `HARNESS_CODEBUDDY_EXTENSION_PROBE=1 node packages/adapter-codebuddy/scripts/probe-extensions.mjs --full` with a
test-only `CODEBUDDY_API_KEY_FILE` (private permissions), optional `CODEBUDDY_MODEL`, and the existing approved route
environment. The script uses at most 0.05 USD per case and 60 seconds per run, outputs redacted evidence only, and is
blocked without explicit opt-in or a credential. Full mode covers combined Skill/MCP/question, deny, cancel and resume.
It does not grant certification automatically; unselected live canary, target-platform artifact and release gates remain.

No credential value or production configuration was inspected. Windows 11 x64 evidence must be gathered on Windows.
The native Windows containment host cannot be built or certified by the macOS run. Portable Runtime requires a
separate supported Node 22 executable; Electron's embedded Node is not a replacement.
