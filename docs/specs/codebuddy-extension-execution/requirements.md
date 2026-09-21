# CodeBuddy Extension Execution Requirements

## Context

The `zb-dev` baseline at `c8d4084` has a healthy Local Runtime, public SDK, extension discovery, extension selection,
capability checks, cancellation, permission interactions, and question interactions. It is sufficient for consumers to
build against the Harness Agent Loop, but it is not an extension-execution baseline:

- the Local Runtime validates selected extension IDs but does not pass immutable extension resources to adapters;
- the CodeBuddy Adapter declares `extensions.mcp` and `extensions.skills` as `unsupported`;
- the Reference Adapter has no deterministic MCP/Skill conformance fixture;
- real CodeBuddy tool, permission, question, MCP, and Skill scenarios do not yet have controlled evidence.

Yanbot Agent Showcase requires one real business MCP server and one real versioned Skill in its R0 path. This work
adds the smallest vendor-neutral extension execution seam needed by that consumer without moving Showcase business
logic into Harness or waiting for Remote Runtime work.

## Requirements

1. Keep public run creation vendor-neutral. Consumers select extensions by stable ID/version/config; they never submit
   CodeBuddy SDK types, absolute resource paths, raw MCP process definitions, or secret values in a run request.
2. Resolve every enabled extension before the run starts into an immutable, run-scoped snapshot containing its
   descriptor, kind, version, digest, bounded resource data, and logical credential references.
3. Reject missing, changed, oversized, malformed, duplicate, unsupported, out-of-root, or symlink-escaping resources
   before creating the adapter run. A failed resolution must not start an MCP process or vendor query.
4. Pass resolved resources to adapters through a private, vendor-neutral adapter contract. Do not add local filesystem
   paths or resolved secrets to the public `/v1` protocol, persisted run record, ordinary event payload, or audit log.
5. Support selected local MCP servers with an explicit transport allowlist. The first required transport is `stdio`;
   `http`/`sse` may be enabled only with the same schema, allowlist, timeout, and credential controls. SDK-embedded
   server instances and arbitrary JavaScript objects are out of scope.
6. Support selected Skills as bounded directory snapshots. The CodeBuddy process must see only the selected Skill
   projection for that run, not ambient user/project Skills, plugins, hooks, agents, or settings.
7. Resolve credentials from existing logical credential references at runtime. Plaintext credentials remain forbidden
   in extension descriptors and selection config, and resolved values must be redacted from errors and diagnostics.
8. Map the neutral MCP snapshot to CodeBuddy `mcpServers` with strict validation and map the Skill snapshot through a
   run-private CodeBuddy configuration projection. Vendor-specific types and compatibility logic remain inside
   `packages/adapter-codebuddy`.
9. Route MCP tool use through the existing Harness tool event and permission interaction lifecycle. Allow, deny,
   timeout, duplicate response, question interaction, cancellation, and adapter failure must each converge to exactly
   one stable run terminal state.
10. Cancellation and disposal must bound and clean up the vendor query, MCP child processes/connections, pending
    interactions, and run-private extension projection. No successful terminal event may be emitted before tool and
    extension lifecycle completion.
11. Resume may reuse an adapter session only when the effective extension snapshot is compatible with the session's
    pinned extension identity. A changed extension version, digest, transport, or security-relevant config must fail
    closed or require a new session.
12. The Reference Adapter must provide deterministic extension fixtures that prove selection, snapshot propagation,
    event ordering, interaction, cancellation, and redaction without a vendor credential.
13. A controlled real CodeBuddy suite must prove at least one MCP call, one Skill-guided run, permission allow/deny,
    structured question handling, cancellation, cleanup, and credential redaction before either extension capability is
    declared usable for the Showcase release.
    An explicit host-only experimental launcher may expose candidate native execution with experimental=true and
    liveVerified=false for acceptance runs. It must remain visibly unverified and must never satisfy release readiness;
    default startup remains unsupported. Public Run requests cannot enable this mode.
14. Produce installable SDK and Local Runtime artifacts from the verified commit, record commit/version/SHA256 and a
    compatibility statement, and pass a clean consumer test without access to the Harness source checkout.

## Acceptance criteria

- An SDK consumer can select a discovered MCP and Skill and obtain a real CodeBuddy run whose events prove both were
  effective.
- A missing capability, bad digest, invalid config, unsupported transport, unresolved credential, or changed resume
  snapshot fails before vendor execution with a stable, redacted Harness error.
- Permission allow and deny, `AskUserQuestion`, cancellation, timeout, and adapter failure each finish exactly once and
  leave no MCP process or run-private extension directory behind.
- Public API responses, persisted runs/events, logs, copied diagnostics, and packaged fixtures contain no raw secret or
  development-machine absolute extension path.
- Reference conformance, CodeBuddy unit tests, Local Runtime tests, SDK tests, the controlled real probe, and the clean
  consumer artifact test all pass.
- Yanbot Agent Showcase can lock the resulting artifacts and run its business MCP/Skill without importing Harness
  internal packages or the CodeBuddy SDK.

## Out of scope

- Remote Worker/Queue/Cloud extension transport.
- `extensions.agents`, `extensions.hooks`, an extension marketplace, online installation, or signature distribution.
- Browser Use, Computer Use, or Yanbot business MCP/Skill implementation; those remain consumer extensions.
- Production multi-tenant sandbox certification or arbitrary untrusted third-party MCP execution.
- Fixing CodeBuddy model discovery; the Showcase may use an explicitly configured and preflighted model ID.
- Changing the four-mode product roadmap beyond keeping the new adapter seam runtime-neutral.

## Dependencies and constraints

- Implementation starts from the pushed `zb-dev` commit `c8d4084` in a clean dedicated worktree/branch.
- The existing Remote Worker line remains untouched; no uncommitted files are shared between the two efforts.
- `@tencent-ai/agent-sdk` stays isolated inside `packages/adapter-codebuddy` and pinned to its reviewed exact version
  unless a separately reviewed compatibility change is required.
- Normal CI remains credential-free. Real CodeBuddy verification is opt-in and records only a redacted evidence summary.
