# CodeBuddy Extension Execution Design

## 1. Baseline and boundary

The starting point is `yanbot-harness@c8d4084`. The current public API already models extension descriptors and run
selections, and the Local Runtime already discovers resources and rejects selections when the chosen adapter reports an
unsupported capability. The missing seam is between successful resolution and `AdapterRuntime.startRun()`.

This design preserves three boundaries:

1. public SDK/API requests carry selection intent only;
2. Local Runtime resolves trusted resources into a private run snapshot;
3. each adapter translates that neutral snapshot to its vendor API.

Showcase business tools, Skill wording, Browser, and Computer implementations remain outside this repository.

## 2. Internal extension snapshot

Add an internal adapter-facing contract, provisionally named `AdapterExtensionSnapshot`, in `adapter-api` (or a small
neutral package if package-cycle checks require it). It is not part of the public `/v1` request schema.

The common envelope contains:

- stable extension ID, kind, version, source, and descriptor digest;
- a content digest over the complete bounded snapshot;
- selection config after Schema validation, with logical credential references but no secret values;
- a discriminated resource payload for MCP or Skill;
- limits and provenance needed for adapter validation, without development-machine paths in serializable diagnostics.

The MCP payload contains normalized server name, stdio command/arguments, logical environment credential bindings,
and declared limits. The Skill payload contains bounded UTF-8 file contents with portable relative paths, byte sizes,
and SHA256 digests in a deeply frozen in-memory object. Runtime owns the immutable content; the vendor adapter alone
owns any temporary projection and its disposal. No source or projection path is added to public records or events.

`AdapterRunInput` becomes the public-neutral `RunRequest` plus an optional readonly `extensionSnapshots` collection and
the existing abort signal. Remote transports are not changed in this milestone; Remote Runtime must later define its
own signed/content-addressed delivery for the same neutral semantics.

## 3. Resolution pipeline

The Local Runtime changes the current flow from:

```text
merge selections -> capability check -> discard resolved resources -> start adapter
```

to:

```text
merge selections
  -> capability check
  -> canonicalize and validate resources
  -> read bounded content
  -> verify path/digest stability
  -> validate selection config and credential bindings
  -> create immutable run snapshot
  -> start adapter
  -> dispose snapshot after terminal cleanup
```

Resolution uses `realpath`, root containment, file-count/per-file/aggregate byte limits, explicit file types, and a
before/after identity check to reduce time-of-check/time-of-use races. All symlinks/junctions within Skill trees are
rejected. Files are opened and closed before adapter execution. Portable filename validation rejects Windows reserved
names and case-insensitive collisions. No security property depends on POSIX chmod. The same resolved collection is used
for capability proof and adapter input so validation cannot diverge from execution.

The effective extension digest is pinned to the Harness session when the vendor session is first created. Resume with a
different security-relevant snapshot is rejected as `CONFIGURATION_INVALID`; the caller starts a new Session instead.
Pins are persisted in a private versioned session sidecar containing only adapter session ID and effective digest.
After restart, compatible pins resume; absent or incompatible pins fail closed and require a new adapter session.
Pins are written before publishing session initialization, so interrupted writes cannot authorize stale resume.

The initial MCP schema rejects literal environment values, shell interpreters and Windows batch launchers (`.cmd`/`.bat`).
Windows callers use an executable such as `node.exe` and separate argv, never concatenate shell command strings.
Selection config is empty-only in this release: nonempty configuration is rejected instead of silently ignored until
per-extension schema and override semantics are defined. MCP JSON accepts only `mcpServers` containing strict stdio
records (`command`, `args`, optional `type: stdio`, and `envCredentialRefs`).
Sidecar transport has no snapshot schema yet and must reject extension fields/selections explicitly; only the current
in-process seam is enabled, avoiding silent stripping during JSON schema parsing.

The standalone Runtime loads host-registered resources from `YANBOT_HARNESS_EXTENSIONS_DIR` (`skills/*/SKILL.md`,
`mcp.json`). The SDK managed launcher, local facade and packaged launcher preserve this explicit setting. Runtime
startup performs discovery; consumers use the public extension discovery endpoint and submit ID/version selections.
Registration never uses a sibling Harness checkout or accepts arbitrary paths in an API request. No extension secret
provider is exposed by this standalone directory format; embedders bind reviewed logical references using the existing
configuration layers/context provider. Discovery metadata changes require restart.

## 4. Credentials and configuration

Existing config layers continue to map logical credential keys to `env:`, `keychain:`, or `secret:` references. This
milestone implements only providers already supported by the selected Local Runtime configuration; it must not silently
treat an unsupported provider as an empty value.

Extension files and per-run selection config may name logical keys, but may not contain values under sensitive names.
The runtime context provider resolves allowed references into process-local values. The CodeBuddy adapter combines
those values with the neutral MCP binding map immediately before the SDK call. Secret values are registered with the
existing redactor and are never written into the snapshot directory.

For the Showcase business MCP, no secret is required. Credential handling is still included in the gate because Browser
or future remote MCPs may require headers, and a permissive shortcut would become a release leak.

## 5. CodeBuddy mapping

### 5.1 MCP

Inside `packages/adapter-codebuddy`, neutral MCP entries map to the pinned SDK's `Options.mcpServers`; the adapter sets
`strictMcpConfig: true`. `stdio` is enabled first. `http` and `sse` remain disabled until their URL/header and network
policy tests pass. SDK in-process server instances are rejected because they cannot cross the neutral adapter boundary.

Tool events continue through the existing CodeBuddy message translator. `canUseTool` remains the single permission
entry point, including `mcp__...` tool names, so MCP calls do not gain a second confirmation mechanism.

### 5.2 Skills

The adapter materializes only selected Skill snapshots into a run-private CodeBuddy configuration directory and points
the child process at that directory using the supported isolated configuration environment. It enables only the minimum
setting source required for that projection and does not load ambient user/project plugins, agents, hooks, MCP files, or
settings.

The exact projection layout and environment variable are finalized by a controlled compatibility probe against the
pinned SDK before implementation is considered complete. If the pinned SDK cannot isolate selected Skills without
loading ambient configuration, `extensions.skills` remains `unsupported`; copying Skills into the consumer workspace or
enabling ambient settings is not an acceptable fallback.

Pinned SDK 0.3.254 inspection found that the Skill loader reads project Skills regardless of settingSources. The
candidate therefore requires a host-created workspace without `.codebuddy`, redirects `CODEBUDDY_CONFIG_DIR` to a
Harness-session-private persistent directory, sets `CODEBUDDY_SESSION_SKILL_DIRS` to a disposable run projection,
clears builtin Skill roots, and uses no setting sources. The persistent directory retains vendor session transcripts
for resume; selected Skill files live only in the disposable projection. A per-session exclusive lease prevents
concurrent projections. Fresh per-run projections never copy or link ambient settings into this directory. Only
Read/Skill/AskUserQuestion built-in tools and selected MCP tools are exposed on this candidate path.

SDK MCP object options become CLI argv JSON. To keep secret values out of argv, logical env bindings become generated
`${HARNESS_MCP_<digest>}` placeholders and secret values enter only the child environment. The pinned stdio environment
expansion seam is documented by vendor `mcp-config-env-expand-service.d.ts`; raw command/args placeholders are rejected.
Live canary scans remain required before capability promotion. No private vendor API is patched.

Offline implementation and probes use an explicit adapter-constructor-only opt-in; production capabilities remain
unsupported until controlled live evidence passes. This option is not a public SDK request or environment override.

### 5.3 Capability declaration

- CodeBuddy `extensions.mcp` changes from `unsupported` only after offline lifecycle tests and the controlled real MCP
  probe pass.
- CodeBuddy `extensions.skills` changes independently only after selected-only isolation and a real Skill proof pass.
- Reference declares the capabilities as `emulated` with explicit fixture limits, never as proof of vendor execution.
- `extensions.agents`, `extensions.hooks`, `models.list`, and unrelated capabilities are unchanged.

## 6. Lifecycle, interactions, and cleanup

The existing single-terminal guard remains authoritative. Extension lifecycle adds resources owned by the active run:

- resolved snapshot/projection directory;
- MCP child process or connection owned by CodeBuddy;
- pending permission/question interactions;
- vendor iterator and abort controller.

Terminal processing stops accepting new interactions, resolves or rejects pending interactions, requests vendor
interrupt, waits only within the existing bounded shutdown budget, and removes the run-private projection. Tests inspect
process and directory cleanup. If the SDK cannot prove process cleanup, the run may terminate for responsiveness but the
real extension gate remains failed and the capability is not promoted.

Tool success is derived from typed vendor tool-result messages. Assistant prose, Skill text, MCP output, or a web page
claiming success cannot synthesize `tool.completed` or `run.completed`.

## 7. Reference and real conformance

Reference Adapter receives deterministic fixtures rather than arbitrary command execution:

- one Skill fixture changes a known response marker;
- one MCP fixture emits discover/start/permission/result lifecycle events;
- allow, deny, question, timeout, cancellation, duplicate response, and redaction cases have fixed outputs;
- snapshot digest and selected extension IDs are asserted without exposing paths.

The opt-in real CodeBuddy probe uses a local, harmless fixture MCP and a minimal Skill. It records versions, capability
summary, event-type sequence, terminal state, cleanup result, and redaction checks. It does not record credentials, full
prompts, absolute paths, or unrestricted tool output.

## 8. Packaging and consumer handoff

After all gates pass:

1. build SDK and Local Runtime artifacts from the same clean commit;
2. generate SHA256 values and update the compatibility matrix;
3. install artifacts into a clean directory with no sibling Harness checkout;
4. run Reference extension conformance and the controlled CodeBuddy MCP/Skill smoke;
5. hand the immutable version/commit/digests to Yanbot Agent Showcase for `harness.lock.json`.

The previously released Preview artifacts do not satisfy this milestone merely because core unit tests pass.

## 9. Reuse

- Reuse discovery/root-containment helpers in `packages/extension-kit` and strengthen them for full snapshots.
- Reuse `AdapterRunInput`, `AdapterRuntimeContext`, and `ManagedRunController` rather than adding a vendor path to core.
- Reuse CodeBuddy `canUseTool`, interaction queues, terminal guard, timeouts, cleanup, and redaction.
- Reuse adapter conformance and Local Runtime E2E harnesses.
- Reuse the existing artifact and compatibility documentation conventions from prior Preview delivery Specs.

## 10. Rejected alternatives

- **Let Showcase call CodeBuddy directly:** rejected because it bypasses the capability and interaction proof the demo is
  intended to show.
- **Put raw paths or MCP JSON in the public RunRequest:** rejected because it leaks local topology, weakens remote
  portability, and exposes vendor/security details to consumers.
- **Load ambient user/project settings to discover Skills:** rejected because the effective extension set becomes
  unprovable and may load unrelated hooks, plugins, or credentials.
- **Copy selected Skills into the consumer workspace:** rejected because it mutates business source and makes cleanup,
  resume identity, and package isolation unreliable.
- **Declare support after unit tests only:** rejected because CodeBuddy tool/interaction behavior and child-process
  cleanup need controlled real evidence.
- **Wait for Remote Worker completion:** rejected because the Showcase R0 path is Local + SDK and Remote transport is an
  independent product milestone.

## 11. Expected files

- `packages/adapter-api/src/index.ts`
- `packages/extension-kit/src/index.ts`
- `packages/adapter-reference/src/index.ts`
- `packages/adapter-codebuddy/src/index.ts`
- `packages/adapter-codebuddy/src/sdk-facade.ts`
- `apps/local-runtime/src/run-supervisor.ts`
- focused tests in the same packages/apps
- `docs/architecture/codebuddy-capability-matrix.md`
- `docs/delivery/compatibility.md`
- artifact/evidence files following the existing delivery conventions
