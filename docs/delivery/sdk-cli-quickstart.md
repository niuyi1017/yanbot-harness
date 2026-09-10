# SDK/CLI Local Preview Quickstart

This guide uses the `0.1.0-preview.2` offline bundle. Node `>=22.22.0 <23` is required. The SDK and CLI connect to the
included loopback Runtime; neither client calls CodeBuddy directly.

## 1. Verify and unpack

From the versioned release directory:

```bash
shasum -a 256 -c SHA256SUMS
mkdir consumer runtime
npm init -y --prefix consumer
npm install --offline --prefix consumer --ignore-scripts --no-audit --no-fund --no-package-lock packages/*.tgz
tar -xzf runtime/yanbot-harness-runtime-0.1.0-preview.2-<platform>-<arch>.tar.gz -C runtime
```

The included Zod tarball makes the public package install independent of a public Registry. Do not replace a
checksum-verified artifact after installation.

## 2. Start the credential-free Runtime

For an SDK- or CLI-owned Runtime, skip the manual background process and use the managed examples below with the
verified launcher path. Managed mode never downloads or updates the Runtime.

SDK-owned startup:

```js
import { startManagedRuntime } from '@yanbot-harness/sdk';

const runtime = await startManagedRuntime({
  executablePath: './runtime/yanbot-harness-runtime-0.1.0-preview.2-<platform>-<arch>/bin/yanbot-harness-runtime',
  reference: true,
});
try {
  console.log(await runtime.client.listAdapters());
} finally {
  await runtime.close();
}
```

CLI-owned startup:

```bash
export YANBOT_HARNESS_ADAPTER=reference
./consumer/node_modules/.bin/yanbot-harness adapters \
  --managed-runtime ./runtime/yanbot-harness-runtime-0.1.0-preview.2-<platform>-<arch>/bin/yanbot-harness-runtime \
  --json
```

For a shared Daemon used by multiple SDK/CLI processes, start it manually:

```bash
export YANBOT_HARNESS_STATE_DIR="$PWD/runtime-state"
./runtime/yanbot-harness-runtime-0.1.0-preview.2-<platform>-<arch>/bin/yanbot-harness-runtime --reference
```

The Runtime prints only its loopback origin. It writes a mode-0600 descriptor to
`$YANBOT_HARNESS_STATE_DIR/runtime.json`; that file contains the Runtime access token and must not be shared.

## 3. Call through the CLI

In a second terminal when using the shared Daemon:

```bash
export YANBOT_HARNESS_RUNTIME_DESCRIPTOR="$PWD/runtime-state/runtime.json"
./consumer/node_modules/.bin/yanbot-harness adapters --json
./consumer/node_modules/.bin/yanbot-harness run "Reply with a delivery check" --json --log-level silent
```

`--json` writes a `cli.run-created` record and public Adapter events as JSONL on stdout. Diagnostics remain on
stderr. Keep the returned Session ID to resume:

```bash
./consumer/node_modules/.bin/yanbot-harness run "Continue" --session <session-id> --resume --json
```

Cancel a known run with `yanbot-harness cancel <run-id>`. CLI exit codes are `0` success, `2` usage, `10`
cancelled/timeout, `11` interaction/permission, `20` authentication, `30` Adapter/upstream, and `40`
Runtime/network/protocol.

## 4. Call through the TypeScript SDK

```js
import { HarnessClient } from '@yanbot-harness/sdk';

const client = await HarnessClient.fromDaemon();
const grant = await client.grantWorkspace({ path: process.cwd() });
const session = await client.createSession({ adapterId: 'cn.yanbot.reference' });
const run = await client.createRun(
  session.sessionId,
  {
    prompt: 'Reply with a delivery check',
    workspaceGrant: grant.grant,
    permissionPolicy: 'interactive',
    configScopes: [],
    extensions: [],
    resume: false,
  },
  { idempotencyKey: 'consumer-generated-stable-key' },
);

let lastEventId;
for await (const event of run.events()) {
  lastEventId = event.eventId;
  if (event.type === 'interaction.requested') {
    await run.respond({ requestId: event.payload.requestId, action: 'deny', message: 'Not approved.' });
  }
}

// Explicit recovery after a disconnected stream:
for await (const event of run.events({ afterEventId: lastEventId })) console.log(event);
```

Pass an `AbortSignal` to `events({ signal })` to stop reading. Use `run.cancel(reason)` to cancel execution; aborting
only the SSE reader does not cancel the run. Handle `HarnessSdkError.kind` and its optional normalized
`harnessError`; do not parse stderr or raw response bodies.

## 5. Start CodeBuddy mode

Stop the Reference Runtime with Ctrl-C and confirm its descriptor was removed. Inject the CodeBuddy credential only
into the Runtime process environment:

```bash
read -s CODEBUDDY_API_KEY
export CODEBUDDY_API_KEY
export CODEBUDDY_INTERNET_ENVIRONMENT=internal
export YANBOT_HARNESS_STATE_DIR="$PWD/codebuddy-runtime-state"
./runtime/yanbot-harness-runtime-0.1.0-preview.2-<platform>-<arch>/bin/yanbot-harness-runtime
```

SDK/CLI consumer processes need only the new Runtime descriptor. Do not put the CodeBuddy key in source code,
command arguments, `.env` files, descriptors, logs, or client requests. CodeBuddy model listing is intentionally
unsupported in this Preview; tool, permission, and question scenarios are implemented but not real-certified.

## 6. Troubleshooting and shutdown

- `descriptor could not be read`: start the Runtime or set `YANBOT_HARNESS_RUNTIME_DESCRIPTOR` to its descriptor.
- `descriptor permissions are too broad`: restrict it to the current user (`chmod 600`).
- `AUTHENTICATION_FAILED`: verify the Runtime—not the client—received a current CodeBuddy key and the `internal`
  route.
- `CAPABILITY_UNSUPPORTED`: inspect `adapters --json`; do not assume every Adapter implements every public endpoint.
- SSE disconnect: reconnect with the last event ID. Do not create a second run unless a new execution is intended.
- Exit code `11` in JSON/non-TTY mode: the run needs an explicit Interaction response from an SDK/API consumer.

Send SIGINT/SIGTERM to the Runtime and wait for exit. Normal shutdown cancels active work, closes loopback sockets,
and removes the owned descriptor. Keep the entire previous checksum-verified release directory for rollback; if a
credential was exposed, revoke/rotate it separately because artifact rollback cannot invalidate a key.
