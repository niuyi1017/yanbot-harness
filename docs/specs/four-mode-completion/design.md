# Design

## Existing components to reuse

- `apps/cloud-server/src/auth`: provisioned device exchange, rotating refresh families and tenant identity.
- `apps/cli/src`: existing profiles, connection routing, interaction prompts and exit codes.
- `apps/cloud-server/src/execution` and persistence: transactional run ownership and execution grants; state writes must share their lease/attempt fencing.
- `packages/sandbox-model-channel`: bounded private request/response frames, backpressure and cancellation. Extend validated schemas instead of opening container networking.
- `packages/sandbox-docker` / `apps/sandbox-runtime`: ephemeral, non-root, network-disabled containers and snapshot transport.
- `apps/cloud-server/src/workspaces`: snapshot limits, path validation and TTL; Git materialization feeds the same validated snapshot path.

## CLI identity storage

Add `login`, `logout`, `auth-status` commands for an explicit Remote target or Remote profile. Login accepts organization/device IDs and reads the device secret from a masked interactive terminal; automation may supply the dedicated device-secret environment variable. No secret argv option. Reuse existing `/v1/auth/device/exchange` and `/v1/auth/refresh`.

Each normalized HTTPS origin (HTTP only for loopback development) maps to a SHA-256 named credential record under a private credentials directory. Store only the token pair and origin. Validate regular-file ownership, no symlink, mode 0600 and size. POSIX directory 0700; unsupported protection must fail closed. Use an exclusive per-origin lock and atomic replacement for refresh rotation. Do not automatically steal a lock from an unknown/live process. Tokens with <30 seconds remaining refresh once while holding the lock; waiting clients reread the replacement. Network requests have timeouts, reject redirects and never expose response error bodies. Environment access tokens retain precedence. Logout revokes the server token family before deleting local credentials; an already rejected/expired refresh may still be removed locally.

## Session and tools

Persist only platform-owned conversation/workspace state, never a complete vendor HOME or credentials. Native vendor recovery requires a verified allowlist; otherwise implement and advertise emulated continuity explicitly. Final state is committed before the terminal event under the active execution lease. Previous committed state survives a failed attempt. Never automatically replay uncertain side effects after a crash.

Tool-bearing messages remain private to the model channel; normalized public tool/interaction events retain existing schemas. The selected permission policy must be enforced by the adapter before each tool execution. Container isolation stays in force. Provider protocol conversions must validate full tool calls and fragmented arguments before accepting terminal success.

## Git / production

Materialize a pinned commit outside the container, through a bounded allowlisted fetcher. Feed only regular files into the existing snapshot validator. Disable local protocols, hooks, credentials, submodules and LFS; reject unresolved links and `.git` paths. Production options validate TLS and access controls before startup, with deployment documentation and failover evidence. Shared state must not rely on process-local ownership.

## Rejected alternatives

Persisting vendor HOME risks storing tokens and unrelated configuration. Passing long-lived model credentials into containers breaks the existing Broker boundary. Blindly enabling production flags would hide missing operational gates. Accepting tokens on argv would expose them through process listings. These approaches are excluded.

Detailed state/protocol schemas will be added here before their implementation as vendor probes establish the supported contract.

### Git materialization contract

The first production fetcher supports public `github.com/<owner>/<repo>[.git]` repositories only, with `github.com` explicitly present in the deployment allowlist. Other hosts fail preparation rather than publishing unusable metadata. It fetches the immutable SHA archive directly from fixed `https://codeload.github.com/<owner>/<repo>/tar.gz/<40-hex-sha>` with redirects rejected and a 30-second deadline. No Git executable, credentials, hooks, submodules or LFS are executed. Only bounded regular-file/directory archive entries are converted into the existing validated snapshot; links, special files, `.git`, `.gitmodules` and LFS pointer files are rejected explicitly. Compressed and expanded bytes are capped independently, with at most two preparations per server process. Repository source/commit remain in the public record; content digest and storageKey point to the materialized snapshot. Workers require that storageKey for Git and an isolated sandbox. Private repositories and additional Git hosting providers require their own credential/fetcher design and are outside this first provider contract.

### Session checkpoint transaction

`SessionRecord.checkpoint` holds version, original workspace digest, immutable checkpoint workspaceRef, expiry and at most 64 KiB of JSON conversation history. `RunRecord.resumeFrom` captures that committed version at admission; `RunRecord.pendingCheckpoint` is a candidate belonging to the current attempt. Resume requires a compatible base workspace digest and a live checkpoint. The internal run response augments the vendor prompt with explicitly quoted historical user/assistant/tool events; public run input stays unchanged. This is emulated conversation continuity, not vendor-native session replay.

Before a sandbox emits `run.completed`, it sends one bounded private `state.save` frame containing a validated workspace snapshot and waits for `state.saved`. The host forwards it through the claimed execution grant to an internal checkpoint endpoint. New immutable files are staged first; the candidate is attached transactionally only while the run/attempt/worker lease is live. The terminal event transaction promotes that candidate and advances the Session version. Cancellation, failure or a stale attempt never promotes a candidate. Orphan files expire through workspace cleanup. Expired checkpoint history is removed by the same maintenance command. No automatic re-execution of uncertain tools is introduced.

Events and checkpoint promotion both touch the leased attempt inside the Mongo transaction, so recovery/revocation conflicts with stale writers. Resume restores the checkpoint workspace in a new container and leaves the previous checkpoint untouched. Checkpoint transport has a 32 MiB frame limit, snapshot limits of 16 MiB file bytes and 2048 files (matching sandbox boot), one save per run and a 30-second acknowledgement deadline. Oversized state fails the run explicitly; it is never silently discarded while advertising successful recovery.

### Verified vendor interaction contract

Pinned Claude Code 2.1.284 was probed against a local synthetic Messages upstream on macOS: `--bare` hides Write/AskUserQuestion. Tool execution instead uses isolated HOME, `--setting-sources '' --strict-mcp-config --safe-mode --no-session-persistence`, an explicit built-in tool list, `--input-format stream-json`, `--permission-prompt-tool stdio` and default permission mode. The private CLI host keeps stdin open for bounded control responses and closes after the final result. `control_request` subtype `can_use_tool` maps to existing Harness permission/question interactions; responses use the matching vendor request ID. No permission bypass flags are used. Unsupported control types fail closed. Probe evidence: actual Write created the fixture file and AskUserQuestion received its answer before a successful final result. Reference: https://code.claude.com/docs/en/cli-reference and official Python SDK control protocol source.

Both disconnected vendor adapters expose an explicit built-in tool set and at most eight model requests/turns. Read-only policy excludes mutation/command tools. Interactive mutations require an existing Harness interaction response; auto-edit may use the vendor's edit policy, with command execution still subject to permission. Broker policies explicitly opt into tools with `allowTools: true`; default policies stay text-only. Messages tool_use/tool_result and OpenAI function tool_calls/tool messages are validated and converted, including fragmented JSON arguments, matching IDs and tool definitions. Unknown tool names or malformed arguments fail before execution. Native vendor resumability remains unsupported in ephemeral CLI HOME; Remote provides the checkpoint-based emulation above.

### Production deployment contract

Production vendor enablement uses a new explicit `CLOUD_ENABLED_VENDOR_ADAPTERS` allowlist plus `CLOUD_VENDOR_SANDBOX_IMAGE` immutable digest, Broker policies, internal API and relay. Legacy experimental flags remain forbidden in production. Worker claims advertise the configured sandbox image; the server rejects vendor claims that do not match its pinned image. Worker model bridging is permitted in production only with sandbox execution, HTTPS internal API and authenticated TLS Redis. Production Mongo requires authenticated TLS replica-set/SRV configuration and startup verifies replica-set availability. Insecure certificate switches are rejected.

TLS termination stays outside the application. Trust only configured proxy CIDRs; loopback bindings default to loopback proxies, and non-loopback production bindings require `CLOUD_TRUST_PROXY_CIDRS`. Redis production URLs require a named ACL user and password (not the default user). These checks validate configuration and ownership; they cannot prove external firewall rules or a provider acceptance that has not been run.

Multiple API/Worker processes share Mongo, Redis and the same protected workspace storage. Session ownership, event sequence and checkpoint promotion are fenced in Mongo transactions. Expired attempts with uncertain side effects are terminated; they are not silently replayed. Tests exercise replacement workers and stale event/checkpoint writes. Operations documentation supplies ACL command/key scopes, replica-set/index preparation, shared-storage/TTL requirements and a deployment preflight. Production rollout itself remains outside this development request.
