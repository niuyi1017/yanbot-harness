# @yanbot-harness/sdk

Node.js 22 client for a Yanbot Harness Runtime. The SDK uses the public HTTP/SSE protocol and does not start or call
CodeBuddy directly.

```ts
import { HarnessClient } from '@yanbot-harness/sdk';

const client = await HarnessClient.fromDaemon();
const grant = await client.grantWorkspace({ path: process.cwd() });
const session = await client.createSession({ adapterId: 'cn.yanbot.reference' });
const run = await client.createRun(session.sessionId, {
  prompt: 'Reply with a delivery check.',
  workspaceGrant: grant.grant,
  permissionPolicy: 'read-only',
  configScopes: [],
  extensions: [],
  resume: false,
});

for await (const event of run.events()) {
  console.log(event);
}
```

Use `HarnessClient.connect({ origin, accessToken })` for an explicit Runtime, `fromRuntime(handle)` for an embedded
Runtime, or `fromDaemon()` for the protected local descriptor. Keep the last event ID and pass it as `afterEventId`
when explicitly resuming SSE. Pass an `AbortSignal` to stop reading without creating a hidden retry.

To explicitly own the lifecycle of an already installed Runtime executable, use `startManagedRuntime()`:

```ts
import { startManagedRuntime } from '@yanbot-harness/sdk';

const runtime = await startManagedRuntime({
  executablePath: '/verified/install/bin/yanbot-harness-runtime',
  reference: true,
});
try {
  console.log(await runtime.client.listAdapters());
} finally {
  await runtime.close();
}
```

`YANBOT_HARNESS_RUNTIME_PATH` may be used instead of `executablePath`. This API never downloads a Runtime and does
not accept a vendor-specific API key field. If a custom `environment` is supplied, it becomes the complete child
process environment; inject only values intended for the Runtime. A temporary mode-0700 state directory is created
and removed by default. Pass a dedicated `stateRoot` when the caller owns persistent Runtime state.

Permission and question requests arrive as `interaction.requested`; reply through `run.respond(response)`. Cancel a
run through `run.cancel(reason)`. Errors are `HarnessSdkError` with stable `kind`, optional HTTP status/request ID,
and an optional normalized Harness error. The SDK never accepts a CodeBuddy API key.

This Local Preview supports Node `>=22.22.0 <23`; browsers are not supported. It requires the separately delivered
Runtime companion or another protocol-compatible Harness Runtime.

The `preview.3` development candidate implements a separate `@yanbot-harness/local` facade that re-exports this client
and supplies signed installed-platform Runtime discovery. The SDK itself has no Runtime production or optional
dependency. Advanced hosts may inject `runtimeResolver`, `nodeExecutablePath` and startup/shutdown budgets; selected
explicit paths retain legacy compatibility and never silently fall back. New managed resolution requires exact
release/protocol identity and private IPC. Complete containment and production publication remain gated. If a vendor
credential is already present in the host environment, managed inheritance does not hide it from the host; prefer a
Runtime-read credential file. See the repository's `docs/specs/unified-local-distribution/`.
