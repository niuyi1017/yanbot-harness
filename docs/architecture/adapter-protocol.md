# Adapter Protocol 1.0

This document is the implementation guide for the vendor-neutral contracts defined by
`@yanbot-harness/contracts` and the lifecycle exposed by `@yanbot-harness/adapter-api`. The Zod schemas remain the
executable source of truth.

The process, Runtime, credential, and deployment boundaries are defined by
[`system-architecture.md`](./system-architecture.md). This document refines the Adapter boundary only and must not
introduce a client-to-vendor or Remote-API-to-vendor shortcut.

## Boundary

An adapter translates one harness implementation into the common run and event model. Public packages and callers
must not import vendor SDK types, inspect vendor message shapes, or branch on a vendor name. Vendor configuration,
permission modes, errors, and raw messages are normalized inside the adapter.

Objects that cross a package or process boundary must be JSON-serializable. Runtime-only controls such as
`AbortSignal` stay in `adapter-api`; Sidecar cancellation is an explicit request.

## Lifecycle

1. Register an adapter by its globally unique `adapterId`.
2. Call `probe()` to determine whether the harness is available in the supplied environment.
3. Call `createRuntime()` with isolated configuration and credentials.
4. Read and enforce `capabilities()` before invoking optional methods.
5. Start or resume one run and consume its event stream in order.
6. Call `cancel()` when requested and always call `dispose()` in a `finally` path.

`cancel()` and `dispose()` are idempotent. A runtime must not retain credentials or mutable session state in a
process-global singleton.

## Capability rules

Each capability is `native`, `emulated`, or `unsupported`. A callable optional method and its declared capability
must agree. In protocol 1.0 this is enforced for model listing, session resume, and interaction responses. Unsupported
operations fail with `CAPABILITY_UNSUPPORTED`; manifest, method, and protocol contradictions fail with
`ADAPTER_INCOMPATIBLE`.

Capability detection is runtime-specific. Callers must not infer support from the adapter or harness name.

## Run event invariants

- Every stream starts with `run.started` at sequence 1.
- `runId` and `sessionId` match the request on every event.
- Sequence numbers increase by exactly one.
- A stream ends with exactly one of `run.completed`, `run.failed`, or `run.cancelled`.
- Nothing may be emitted after a terminal event.
- `adapterMetadata` contains only small, sanitized diagnostic fields, never a raw vendor message, credential, full
  environment, or user file content.

`session.initialized.payload.adapterSessionId` is opaque to every component except the originating adapter. Persisting
that value enables a later `resumeRun()` call without exposing vendor session semantics.

## Interactions

Adapters register a pending interaction before emitting `interaction.requested`, allowing the consumer to respond
immediately. A response is correlated by `requestId`; it produces one `interaction.resolved` event before the run
continues or fails. Unknown, repeated, expired, or post-disposal responses are rejected.

Public permission policies are `interactive`, `auto-edit`, and `read-only`. Their vendor-specific mapping belongs
inside each adapter and must default to the least surprising safe behavior.

## Sidecar transport

`@yanbot-harness/adapter-sidecar` maps the same contracts to JSON-RPC 2.0 over JSON Lines. Initialization negotiates
the protocol version before any run method. Events are notifications; cancellation and interaction responses are
requests. The foundation package defines schemas only and does not spawn or supervise processes.

Protocol versions use SemVer. An incompatible major version must be rejected during registration or initialization;
additive compatible changes may use a minor version.

### CLI-backed sidecars

A vendor CLI is not itself a Harness Sidecar. A vendor-specific wrapper owns the CLI as a child process and exposes
the Harness Sidecar protocol to the Runtime:

```text
Runtime / Worker
  -> JSON-RPC JSONL
Vendor Sidecar Wrapper
  -> argv + isolated stdin/stdout/stderr pipes
Vendor CLI
```

The wrapper's stdout is reserved for Harness protocol frames. Vendor stdout and stderr must never be forwarded there
verbatim; the wrapper parses a documented machine-readable vendor format and emits normalized Harness events. Plain
human terminal text scraping is experimental unless a pinned parser, fixtures, and compatibility gate prove it stable.

The wrapper owns vendor version probing, argument construction, credential allowlisting, session ID mapping, exit-code
normalization, cancellation escalation, and process-tree cleanup. POSIX process groups and Windows process trees need
separate tests. Unsupported vendor behavior such as resume, structured interactions, model discovery, or token usage
must be reported through capabilities rather than emulated silently.

Detailed requirements and implementation phases are in
[`docs/specs/cli-harness-adapter/`](../specs/cli-harness-adapter/requirements.md).
