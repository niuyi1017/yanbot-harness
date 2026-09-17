# SDK/CLI Local Preview Quickstart

This guide uses the `0.1.0-preview.2` offline bundle. Node `>=22.22.0 <23` is required. The SDK and CLI connect to the
included loopback Runtime; neither client calls CodeBuddy directly.

This is the current explicit-path workflow. The proposed `@yanbot-harness/local` single-entry installation and automatic
Runtime discovery belong to a later Preview and are not available in these artifacts. Future plans are recorded in the
repository under `docs/specs/unified-local-distribution/`; use the commands below for `preview.2`.

The source-tree preview.3 candidate also contains neutral `/v1` SDK targets and CLI Local/Remote profiles. Those
options are not present in this immutable preview.2 bundle. Migration syntax and current Remote limitations are
documented in [`runtime-target-profiles.md`](./runtime-target-profiles.md).

For a complete Windows 10/11 handoff, including PowerShell installation, SDK integration code, CodeBuddy BYOK,
acceptance reporting, and cleanup, use
[`windows-sdk-cli-integration-guide.zh-CN.md`](./windows-sdk-cli-integration-guide.zh-CN.md).

## 1. Verify and unpack

From the versioned release directory on macOS/Linux:

```bash
shasum -a 256 -c SHA256SUMS
mkdir consumer runtime
npm init -y --prefix consumer
npm install --offline --prefix consumer --ignore-scripts --no-audit --no-fund --no-package-lock packages/*.tgz
tar -xzf runtime/yanbot-harness-runtime-0.1.0-preview.2-<platform>-<arch>.tar.gz -C runtime
```

The included Zod tarball makes the public package install independent of a public Registry. Do not replace a
checksum-verified artifact after installation.

On Windows 10/11 x64, use PowerShell from the versioned release directory:

```powershell
Get-Content .\SHA256SUMS | ForEach-Object {
  $expected, $relative = $_ -split '\s{2}', 2
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $relative).Hash.ToLowerInvariant()
  if ($actual -ne $expected) { throw "Checksum mismatch: $relative" }
}

New-Item -ItemType Directory -Force .\consumer, .\runtime | Out-Null
npm init -y --prefix .\consumer
$packages = (Get-ChildItem .\packages\*.tgz).FullName
npm install --offline --prefix .\consumer --ignore-scripts --no-audit --no-fund --no-package-lock $packages
Expand-Archive -LiteralPath .\runtime\yanbot-harness-runtime-0.1.0-preview.2-win32-x64.zip -DestinationPath .\runtime
```

The Windows bundle requires Node `>=22.22.0 <23`. It does not contain Node or install a system service.

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

On Windows, set `executablePath` to the canonical Node launcher:

```js
const runtime = await startManagedRuntime({
  executablePath: './runtime/yanbot-harness-runtime-0.1.0-preview.2-win32-x64/bin/yanbot-harness-runtime.js',
  reference: true,
});
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

Windows PowerShell equivalents use the `.js` launcher for managed mode so the SDK can retain exact PID ownership:

```powershell
$runtimeLauncher = Resolve-Path .\runtime\yanbot-harness-runtime-0.1.0-preview.2-win32-x64\bin\yanbot-harness-runtime.js
$cli = Resolve-Path .\consumer\node_modules\@yanbot-harness\cli\dist\main.js
$env:YANBOT_HARNESS_ADAPTER = 'reference'
node $cli adapters --managed-runtime $runtimeLauncher --json

# Shared Daemon, when required by multiple SDK/CLI processes:
$env:YANBOT_HARNESS_STATE_DIR = Join-Path $PWD 'runtime-state'
node $runtimeLauncher --reference
```

The sibling `yanbot-harness-runtime.cmd` is a convenience launcher for manual PowerShell/cmd use. Managed SDK/CLI
may also receive that exact bundled `.cmd` path and will resolve its verified same-name `.js` launcher.

## 3. Call through the CLI

In a second terminal when using the shared Daemon:

```bash
export YANBOT_HARNESS_RUNTIME_DESCRIPTOR="$PWD/runtime-state/runtime.json"
./consumer/node_modules/.bin/yanbot-harness adapters --json
./consumer/node_modules/.bin/yanbot-harness run "Reply with a delivery check" --json --log-level silent
```

In a second Windows PowerShell terminal:

```powershell
$cli = Resolve-Path .\consumer\node_modules\@yanbot-harness\cli\dist\main.js
$env:YANBOT_HARNESS_RUNTIME_DESCRIPTOR = Join-Path $PWD 'runtime-state\runtime.json'
node $cli adapters --json
node $cli run 'Reply with a delivery check' --json --log-level silent
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

Stop the Reference Runtime with Ctrl-C and confirm its descriptor was removed. Each tester may supply and replace
their own internal-test key without rebuilding any artifact. Configure exactly one of `CODEBUDDY_API_KEY` or
`CODEBUDDY_API_KEY_FILE`; the protected file option is recommended for repeated testing.

On macOS, create a current-user-only credential file without putting the key in shell history, then start the
Runtime:

```bash
credential_dir="$HOME/.config/yanbot-harness"
credential_file="$credential_dir/codebuddy.key"
mkdir -p "$credential_dir"
chmod 700 "$credential_dir"
printf 'CodeBuddy API key: ' >&2
read -r -s codebuddy_key
printf '\n' >&2
umask 077
printf '%s' "$codebuddy_key" > "$credential_file"
unset codebuddy_key CODEBUDDY_API_KEY
chmod 600 "$credential_file"
export CODEBUDDY_API_KEY_FILE="$credential_file"
export CODEBUDDY_INTERNET_ENVIRONMENT=internal
export YANBOT_HARNESS_STATE_DIR="$PWD/codebuddy-runtime-state"
./runtime/yanbot-harness-runtime-0.1.0-preview.2-<platform>-<arch>/bin/yanbot-harness-runtime
```

SDK/CLI consumer processes need only the new Runtime descriptor. Do not put the CodeBuddy key in source code,
command arguments, `.env` files, descriptors, logs, or client requests. CodeBuddy model listing is intentionally
unsupported in this Preview; tool, permission, and question scenarios are implemented but not real-certified.

On Windows PowerShell, create a credential file for the current tester and replace inherited access with an ACL for
that Windows identity. The plaintext exists only while the file is being written:

```powershell
$secureKey = Read-Host 'CodeBuddy API key' -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
$credentialDirectory = Join-Path $env:LOCALAPPDATA 'YanbotHarness'
$credentialFile = Join-Path $credentialDirectory 'codebuddy.key'
New-Item -ItemType Directory -Force -Path $credentialDirectory | Out-Null
try {
  $plainKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [IO.File]::WriteAllText($credentialFile, $plainKey, $utf8)
} finally {
  $plainKey = $null
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
icacls $credentialFile /inheritance:r /grant:r "${identity}:F" | Out-Null
Remove-Item Env:CODEBUDDY_API_KEY -ErrorAction SilentlyContinue
$env:CODEBUDDY_API_KEY_FILE = $credentialFile
$env:CODEBUDDY_INTERNET_ENVIRONMENT = 'internal'
$env:YANBOT_HARNESS_STATE_DIR = Join-Path $PWD 'codebuddy-runtime-state'
$runtimeLauncher = Resolve-Path .\runtime\yanbot-harness-runtime-0.1.0-preview.2-win32-x64\bin\yanbot-harness-runtime.js
node $runtimeLauncher
```

After stopping the Runtime, run `Remove-Item Env:CODEBUDDY_API_KEY_FILE` in that PowerShell process. Delete the
credential file when the test cycle ends; rotate the key immediately if the file or terminal session was exposed.

## 6. Troubleshooting and shutdown

- `descriptor could not be read`: start the Runtime or set `YANBOT_HARNESS_RUNTIME_DESCRIPTOR` to its descriptor.
- `descriptor permissions are too broad`: on POSIX, restrict it to the current user (`chmod 600`). On Windows,
  keep the state directory private to the current Windows account and do not copy `runtime.json`.
- `AUTHENTICATION_FAILED`: verify the Runtime—not the client—received a current CodeBuddy key and the `internal`
  route.
- `CAPABILITY_UNSUPPORTED`: inspect `adapters --json`; do not assume every Adapter implements every public endpoint.
- SSE disconnect: reconnect with the last event ID. Do not create a second run unless a new execution is intended.
- Exit code `11` in JSON/non-TTY mode: the run needs an explicit Interaction response from an SDK/API consumer.

On POSIX, send SIGINT/SIGTERM to the Runtime and wait for exit. On Windows, use Ctrl-C for a manually started Daemon;
SDK/CLI managed mode performs bounded owned-process-tree cleanup. Normal interactive shutdown cancels active work,
closes loopback sockets, and removes the owned descriptor. Keep the entire previous checksum-verified release
directory for rollback; if a credential was exposed, revoke/rotate it separately because artifact rollback cannot
invalidate a key.
