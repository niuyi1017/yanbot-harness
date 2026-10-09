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
