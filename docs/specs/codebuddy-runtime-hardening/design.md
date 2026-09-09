# CodeBuddy Runtime Hardening Design

## Vendor evidence

- CodeBuddy documents `result` as the query completion message.
- The repository currently pins SDK `0.3.43`, bundling CodeBuddy CLI `2.48.0`.
- SDK `0.3.254` bundles CLI `2.146.0`. Releases after `2.48.0` include fixes for JS SDK exit tracking,
  `abortSignal`, stream timeout handling, and `dispose`/`kill`/`wait` hangs.
- A controlled probe on 2026-09-08 showed the configured key is rejected by the internal endpoint. SDK `0.3.43`
  emitted `401 Unauthorized` as assistant content and omitted `result`; SDK `0.3.254` raised an authentication
  `ExecutionError` promptly.

## Dependency upgrade

`packages/adapter-codebuddy/package.json` pins `@tencent-ai/agent-sdk` to `0.3.254`. The adapter manifest and
capability matrix report that exact version. This is the newest stable release outside the workspace's 24-hour
supply-chain waiting window; the dependency remains private to the adapter package and needs no policy exception.

## Lifecycle state

Each active run owns:

- its abort controller and vendor stream;
- one output queue;
- running and settled tool maps;
- last vendor activity time;
- a single terminal flag;
- a memoized best-effort stop operation.

All terminal paths go through one guard so completion, failure, timeout, and cancellation cannot race into duplicate
terminal events.

## Watchdogs

The adapter supports three internal configuration values:

| Setting           |      Default | Purpose                                        |
| ----------------- | -----------: | ---------------------------------------------- |
| `runTimeoutMs`    | 1,800,000 ms | Absolute run deadline                          |
| `idleTimeoutMs`   |   120,000 ms | Maximum time without a vendor message          |
| `shutdownGraceMs` |     5,000 ms | Maximum wait per public SDK shutdown operation |

The consumer races each pending vendor `next()` against both deadlines. Resolving an interaction counts as activity so
the user is not penalized immediately after answering. Wall-clock timeout remains active while an interaction is open;
idle timeout is suspended while an interaction is awaiting the user.

On timeout, running tools are failed, the run emits `RUN_TIMEOUT`, and SDK shutdown starts. The Harness event stream
ends immediately even if the vendor process does not acknowledge interruption.

## Authentication compatibility

New SDK versions throw an execution error for 401. For compatibility with legacy/bundled CLI behavior, an assistant
message whose text is an unambiguous authentication failure is intercepted before it is emitted as user-visible
assistant output and converted to `AUTHENTICATION_FAILED`.

Generic assistant prose is preserved as partial output and never promoted to success.
When the legacy 401 signal appears, the adapter suppresses it as user-facing content and gives the SDK five seconds
to emit its typed error/result so normal SDK cleanup can run. If no terminal follows, the adapter emits the recorded
authentication failure itself and starts bounded shutdown.

## Shutdown

Cancellation first marks the run terminal and resolves pending permission/question calls, then aborts the SDK
controller and invokes `interrupt()` plus async-iterator `return()` with bounded waits. This ordering keeps the public
Harness responsive even when a vendor shutdown path is defective.

The SDK owns its spawned CLI process and, as of the upgraded release line, contains the process termination fixes. We
do not call private SDK members or inspect/kill undocumented PIDs.

## Reuse

- Reuse `AsyncQueue` for event delivery.
- Reuse `AdapterEventFactory` for protocol-valid events.
- Reuse existing error classification and credential redaction in
  `packages/adapter-codebuddy/src/index.ts`.
- Reuse the adapter conformance kit and injected SDK facade for offline lifecycle tests.

## Rejected alternatives

- **Treat the last assistant message as success:** rejected because CodeBuddy, Claude Agent SDK, OpenAI Agents SDK,
  ACP, and MCP all separate progress/content from terminal completion.
- **Call private SDK transport cleanup methods:** rejected because it couples the adapter to undocumented internals and
  makes upgrades unsafe.
- **Wait indefinitely after Abort:** rejected because the observed SDK version can fail to acknowledge cancellation.
- **Add CodeBuddy timeout fields to shared RunRequest:** rejected because these are adapter runtime controls, not stable
  cross-vendor protocol concepts at this milestone.

## Files

- `packages/adapter-codebuddy/package.json`
- `packages/adapter-codebuddy/src/index.ts`
- `packages/adapter-codebuddy/src/sdk-facade.ts`
- `packages/adapter-codebuddy/test/codebuddy.test.ts`
- `pnpm-lock.yaml`
- `pnpm-workspace.yaml`
- `README.md`
- `docs/architecture/codebuddy-capability-matrix.md`
