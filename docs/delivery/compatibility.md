# SDK/CLI Preview Compatibility

## Release baseline

| Component            | Version           |
| -------------------- | ----------------- |
| Contracts            | `0.1.0-preview.2` |
| TypeScript SDK       | `0.1.0-preview.2` |
| CLI                  | `0.1.0-preview.2` |
| Local Runtime bundle | `0.1.0-preview.2` |
| Harness protocol     | `1.0.0`           |
| CodeBuddy Agent SDK  | `0.3.254`         |
| Node.js              | `>=22.22.0 <23`   |
| pnpm (build only)    | `11.10.0`         |

Contracts, SDK, and CLI are released together and must use the same Preview version. The Runtime bundle records its compatible protocol and client versions in the release manifest.

## Delivery channel

The first release is a Local Preview delivered as a platform-named outer ZIP plus a separate SHA-256 file. The same
common contracts, SDK, CLI, and Zod package artifacts are assembled into each platform candidate and may be uploaded
to an approved private npm registry without rebuilding them. Public npm publication is not part of this release.

The SDK and CLI require a compatible Harness Runtime. They do not connect directly to CodeBuddy and do not accept a CodeBuddy credential from an SDK or CLI request.

## Certified environments

| Environment                | Status            | Evidence                                                                                        |
| -------------------------- | ----------------- | ----------------------------------------------------------------------------------------------- |
| macOS arm64, Node 22       | Preview certified | Local packaged CodeBuddy initial/resume/cancel/CLI gate plus `macos-15` Reference clean-room CI |
| Linux x64, Node 22         | Delivery target   | `ubuntu-24.04` managed/Daemon clean-room Reference CI                                           |
| Windows 10/11 x64, Node 22 | Candidate         | Windows Server 2022 Reference CI passed; desktop and real CodeBuddy acceptance remain pending   |
| Browser                    | Not supported     | The Preview SDK includes Node-only Runtime discovery and process management                     |
| Cloud multi-tenant Runtime | Not supported     | Deferred to the cloud control-plane milestones                                                  |

## Protocol compatibility

- Clients validate all HTTP responses and SSE events against public contracts.
- A different Harness protocol major version is incompatible and must fail with a protocol error.
- Preview package versions follow `0.x` semantics: a minor version may contain a documented breaking change.
- SSE reconnection is explicit. Consumers keep the last event ID and resubscribe; the SDK does not perform an unlimited hidden retry.

## Frozen Preview API

The public Node.js exports are `HarnessClient`, `RunHandle`, `readRuntimeDescriptor`, `startManagedRuntime`,
`HarnessSdkError`, their documented public types, and the schemas/types re-exported from
`@yanbot-harness/contracts`. Adapter, Runtime, and vendor SDK types are not public SDK dependencies.

| API                                                                             | Result / behavior                                                                                                |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `HarnessClient.connect(options)`                                                | Connect with an explicit Runtime origin and bearer token.                                                        |
| `HarnessClient.fromRuntime(handle)`                                             | Connect from an embedded Runtime handle.                                                                         |
| `HarnessClient.fromDaemon(options?)`                                            | Read a mode-0600 local descriptor and connect.                                                                   |
| `startManagedRuntime(options?)`                                                 | Start an installed Runtime, validate readiness, and return an owned client/close handle.                         |
| `health()`                                                                      | Validate Runtime health and protocol response.                                                                   |
| `grantWorkspace()` / `revokeWorkspaceGrant()`                                   | Create or revoke a path-scoped workspace grant.                                                                  |
| `createSession()` / `listSessions()` / `getSession()`                           | Manage public Session records.                                                                                   |
| `createRun()` / `getRun()` / `cancelRun()`                                      | Create idempotent runs, inspect state, or cancel.                                                                |
| `events(runId, options?)`                                                       | Consume schema-validated SSE; `afterEventId` resumes explicitly and `signal` aborts the reader.                  |
| `respondToInteraction()`                                                        | Submit a schema-valid permission or question response.                                                           |
| `listAdapters()` / `listModels()` / `getEffectiveConfig()` / `listExtensions()` | Read negotiated Runtime capabilities and configuration. Individual Adapters may return `CAPABILITY_UNSUPPORTED`. |

`RunHandle` exposes the created `run`, the `reused` idempotency result, and convenience `events`, `refresh`, `cancel`,
and `respond` methods. `HarnessSdkError.kind` is one of `authentication`, `request`, `runtime`, `network`, or
`protocol`; its optional status, request ID, and normalized Harness error are stable Preview fields. Response bodies
that fail the public schemas become `protocol` errors and raw non-protocol bodies are not included in messages.

The CLI command surface is frozen to `run`, `adapters`, `models`, `sessions`, `run-status`, and `cancel`, plus
`--help`/`--version`. JSON mode writes one JSON value per stdout line; diagnostics stay on stderr. Exit codes are
`0` success, `2` usage, `10` cancellation/timeout, `11` interaction/permission, `20` authentication, `30` Adapter or
upstream failure, and `40` Runtime/network/protocol failure. Connection modes are mutually exclusive: explicit
`--runtime` plus the environment token, explicit `--descriptor`, explicit `--managed-runtime`, or default Daemon
descriptor discovery.

## CodeBuddy routing

The certified China service configuration is:

```text
CODEBUDDY_INTERNET_ENVIRONMENT=internal
```

Configure exactly one Local Runtime credential source: `CODEBUDDY_API_KEY`, or `CODEBUDDY_API_KEY_FILE` pointing to
a protected one-line UTF-8 file. The file source lets each tester replace the internal-test key without rebuilding
the SDK, CLI, or Runtime. The Runtime reads it once at startup and does not pass it to SDK/CLI processes. POSIX
systems require mode `0600` or stricter; Windows testers must restrict the file ACL to their own account. Internal
routing must not set a custom base URL. Enterprise, iOA, cloud-hosted, and self-hosted routing require separate
certification.

The Windows Runtime bundle requires PowerShell 5.1+ for the documented archive workflow and ships a Node launcher for SDK/CLI managed mode plus a `.cmd` convenience launcher. Windows arm64 and native `.exe`/MSI delivery are not part of this Preview.

Windows testers should follow [`windows-sdk-cli-integration-guide.zh-CN.md`](./windows-sdk-cli-integration-guide.zh-CN.md). Its acceptance result is required before changing Windows 10/11 from Candidate status.

## Capability statement

The exact CodeBuddy evidence level for streaming, resume, cancellation, interactions, models, usage, and extensions is maintained in [`docs/architecture/codebuddy-capability-matrix.md`](../architecture/codebuddy-capability-matrix.md). A documented or fixture-tested capability is not described as real-verified until the packaged release path passes the controlled scenario.
