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
