# CEE-T1–CEE-T4 offline evidence

Date: 2026-09-21. Host: macOS arm64. Source base: `c8d4084`, dedicated `feat/codebuddy-extension-execution` worktree.

## Verified

- Dependency-ordered builds through `@yanbot-harness/local` and `@yanbot-harness/local-runtime` passed.
- Extension Kit: 23 tests passed. Covers bounded immutable source snapshots, descriptor drift, nested depth and total
  bytes, duplicate/version/config rejection, strict stdio config, logical credential identity, CRLF frontmatter,
  portable filename restrictions, symlink rejection, and snapshot independence after source changes.
- Local Runtime: 57 tests passed, including 6 new extension tests. Covers registered resource propagation through Core,
  both extension fixture effects, private persisted pin, restart resume, changed/removed extension rejection,
  idempotent permission response, deny/cancel terminal behavior, missing credential rejection and secret redaction.
- Reference Adapter: 9 tests passed, including 3 extension conformance tests. Covers ordered typed events, Skill digest
  marker, MCP permission plus tool result, structured question, in-flight tool cancellation, and unresolved selection
  rejection. Source contents and command paths never enter fixture output.
- Sidecar: 3 tests passed. Private snapshots and extension selections fail schema validation instead of being stripped.
- Local facade: 3 tests passed. Packaged launcher environment test: 1 passed.
- Targeted ESLint, package-boundary checks and `git diff --check` passed.

## Consumer registration

Set `YANBOT_HARNESS_EXTENSIONS_DIR` in the host environment passed to the managed Runtime, local facade, or packaged
launcher. It names an absolute trusted directory with `skills/<name>/SKILL.md` and optional `mcp.json`. Use public SDK
extension discovery and ID/version selections. No sibling source or internal package imports are needed.

`mcp.json` contains a `mcpServers` object with records of `command`, `args`, optional `type: "stdio"`, and optional
`envCredentialRefs`. Use a Node executable and argv on Windows; `.cmd`, `.bat` and shell interpreters are rejected.
Literal `env` values and nonempty selection config are rejected. The initial standalone directory registration carries
no credential provider; credential-aware embedders use existing trusted config layers and context provider.

The private Adapter SPI input is `extensionSnapshots`. Skills are frozen UTF-8 `files` with relative path/content/bytes/
digest. MCP resources contain name/transport/command/args/logical env references. Neither source paths nor secrets are
added to public Run/Session schemas. The vendor adapter owns all later filesystem projections and process cleanup.

## Remaining release gates

- CodeBuddy MCP mapping, selected-only Skill projection, and controlled live proof remain CEE-T5–CEE-T7. Capabilities
  remain unsupported in CodeBuddy; Reference capabilities are explicitly emulated.
- Windows 11 x64 execution evidence is pending. POSIX-created invalid filename/symlink fixtures are skipped on Windows
  because creating those fixtures itself may require unsupported filenames or elevated privileges. Windows junction,
  permission/ACL, handle cleanup, executable/argv and packaged deployment evidence remain mandatory before certification.
- Current strict snapshots are limited to 32 selected extensions, 128 files per Skill, 256 KiB per file, 2 MiB aggregate
  content and depth 8. They are for host-trusted extensions, not a hostile third-party filesystem sandbox.
- No new SDK/Runtime release artifact has been generated or locked by this work. Clean artifact consumer proof and
  complete repository/release gates remain CEE-T8.
