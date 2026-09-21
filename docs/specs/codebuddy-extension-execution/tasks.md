# CodeBuddy Extension Execution Tasks

Implementation status: CEE-T1 through CEE-T4 implemented and offline-verified on macOS arm64; CEE-T5 through CEE-T8 remain open. Evidence: [offline-evidence.md](offline-evidence.md). The clean implementation base is pushed
`zb-dev@c8d4084`. This feature must use a dedicated worktree/branch and must not share uncommitted files with the Remote
Worker development line.

## CEE-T1 — Freeze the extension execution contract

- Status: `[x]` — private immutable in-memory union; public protocol unchanged; Sidecar explicitly rejects unsupported private transport.
- Files: this Spec; `packages/adapter-api/src/index.ts`; package boundary tests.
- Dependency: Spec review.
- Work: define the private vendor-neutral `AdapterExtensionSnapshot` discriminated union, limits, lifecycle ownership,
  resume identity, and serialization boundary. Confirm that public Run/CreateRun schemas remain vendor-neutral.
- Verification: type tests cover MCP/Skill variants; dependency/boundary checks prove no CodeBuddy types enter shared
  contracts; design review resolves the snapshot owner and cleanup owner before implementation proceeds.

## CEE-T2 — Harden discovery and build immutable snapshots

- Status: `[x]` — bounded UTF-8 snapshots, portable names, root/symlink/stability checks, strict stdio records. No Runtime projection files; ownership moved to CEE-T6.
- Files: `packages/extension-kit/src/index.ts`, extension-kit tests, Local Runtime snapshot helpers.
- Dependency: CEE-T1.
- Work: add bounded recursive Skill snapshots, normalized MCP parsing, Schema validation, realpath/root/symlink checks,
  content digests, before/after stability checks, sensitive-value rejection, and frozen in-memory resources. Per-run config is currently empty-only and unsupported transports fail closed.
- Verification: tests reject traversal, escaping symlinks, mutation during read, duplicate IDs, bad digest/version,
  oversized/deep/file-count payloads, unknown fields, plaintext secrets, and unsupported transports.

## CEE-T3 — Thread resolved resources through Local Runtime

- Status: `[x]` — Core forwarding, credential presence and event redaction, persistent private resume digest pin, terminal publication after disposal, standalone trusted registry entry point and launcher passthrough.
- Files: `apps/local-runtime/src/run-supervisor.ts`, `apps/local-runtime/src/adapters.ts`, Local Runtime tests.
- Dependency: CEE-T2.
- Work: use one resolved collection for capability validation and adapter execution; bind logical credentials through the
  context provider; pin effective extension identity for resume; clean projections on every terminal/startup-failure path.
- Verification: tests cover no-selection, one/many extensions, missing credential, failed adapter creation, cancellation,
  restart, changed resume digest, and absence of paths/secrets in persisted records/events.

## CEE-T4 — Add deterministic Reference extension conformance

- Status: `[x]` — emulated digest markers and permission/tool lifecycle; allow/deny/cancel/question tests; never executes configured commands or Skill text.
- Files: `packages/adapter-reference/src/index.ts`, adapter conformance fixtures/tests, Local Runtime E2E.
- Dependency: CEE-T3.
- Work: implement explicitly `emulated` Skill/MCP fixtures for selection proof, tool lifecycle, permission, question,
  cancellation, duplicate responses, output limits, and redaction.
- Verification: credential-free CI executes the full deterministic matrix and reports fixture limitations in capability
  metadata; the fixture cannot execute an arbitrary command or network request.

## CEE-T5 — Map MCP into CodeBuddy

- Status: `[ ]`
- Files: `packages/adapter-codebuddy/src/index.ts`, `sdk-facade.ts`, CodeBuddy adapter tests.
- Dependency: CEE-T3.
- Work: add typed neutral-to-`Options.mcpServers` mapping, `strictMcpConfig`, stdio allowlist, logical env binding,
  mcp tool event/permission handling, bounded output, timeout, cancellation, and cleanup. Keep http/sse disabled until
  their separate policy tests pass.
- Verification: injected SDK tests cover empty/single/multiple configs, malformed and unsupported transports, allow/deny,
  question, timeout, cancel, stream failure, duplicate terminal prevention, redaction, and no leaked child/projection.

## CEE-T6 — Isolate and map selected Skills into CodeBuddy

- Status: `[ ]`
- Files: `packages/adapter-codebuddy/src/index.ts`, `sdk-facade.ts`, Skill projection helpers/tests.
- Dependency: CEE-T3 and a controlled pinned-SDK projection probe.
- Work: prove the pinned SDK's selected-only Skill loading seam; build a run-private CodeBuddy configuration projection;
  disable ambient user/project plugins, hooks, agents, MCP settings, and Skills; remove the projection after cleanup.
- Verification: the selected Skill is visible to the query, an unselected canary Skill is not, source workspace is
  unchanged, resume identity is enforced, and cleanup succeeds on complete/fail/cancel/timeout. If isolation cannot be
  proven, leave `extensions.skills` unsupported and stop the R0 release gate.

## CEE-T7 — Promote capabilities with controlled real evidence

- Status: `[ ]`
- Files: opt-in live tests, `docs/architecture/codebuddy-capability-matrix.md`, redacted evidence summary.
- Dependency: CEE-T4–CEE-T6.
- Work: run a harmless local MCP and minimal Skill against a valid CodeBuddy credential; cover MCP result, Skill effect,
  permission allow/deny, structured question, cancellation, resume compatibility, cleanup, and secret/path canaries.
- Verification: real runs produce expected typed event/terminal signals and no canary leakage. Promote MCP and Skill
  capabilities independently only for the scenarios that passed; normal CI remains offline.

## CEE-T8 — Build, verify, and hand off the locked release

- Status: `[ ]`
- Files: release metadata, `docs/delivery/compatibility.md`, SDK/Runtime artifacts and checksums.
- Dependency: CEE-T7 and the existing release pipeline.
- Work: run the full repository gate, build same-commit artifacts, generate SHA256, document supported OS/architecture,
  install in a clean consumer directory, and provide the immutable lock tuple to Yanbot Agent Showcase.
- Verification: `pnpm check`, targeted package tests, Reference extension E2E, real CodeBuddy smoke, package scan, and
  no-sibling-source consumer test pass. Showcase can populate `harness.lock.json` and run the business extension smoke.

## Completion gate

This Spec is complete only when CEE-T1 through CEE-T8 are checked with evidence paths. Passing core SDK/Runtime unit
tests alone, completing Remote Worker features, or simulating extension events in the Showcase does not satisfy it.
