# Runtime target and CLI profile migration

The preview.3 development candidate keeps one SDK and CLI surface for Local and Remote Runtime targets. It does not
ship a Remote service, interactive login, or Remote workspace preparation. Current release certification remains
Local-only.

## SDK migration

New integrations should use a discriminated target and the neutral `/v1` protocol:

```ts
import { HarnessClient } from '@yanbot-harness/sdk';

const local = await HarnessClient.connect({ mode: 'local-daemon' });

const remote = await HarnessClient.connect({
  mode: 'remote',
  origin: 'https://runtime.example.com',
  tokenProvider: async () => ({ accessToken: await loadShortLivedToken() }),
});
```

`local-managed` returns an owned handle and must be closed. Remote origins require HTTPS. Every target performs an
explicit `/v1/health` handshake and fails on a mode or protocol-major mismatch; no target falls back to another.
The synchronous `{ origin, accessToken }`, `fromRuntime`, and `fromDaemon` entry points remain legacy `/local`
clients during the documented Preview compatibility window.

## CLI target selection

Choose exactly one target option:

| Option                          | Target and credential behavior                                       |
| ------------------------------- | -------------------------------------------------------------------- |
| no target / `--descriptor PATH` | Local daemon descriptor; uses neutral `/v1` routes.                  |
| `--managed-runtime PATH`        | Starts and closes that installed Local Runtime for one command.      |
| `--remote HTTPS_URL`            | Remote target; reads `YANBOT_HARNESS_ACCESS_TOKEN` for each request. |
| `--profile NAME`                | Loads a versioned target from the selected profile file.             |
| `--runtime LOOPBACK_URL`        | Legacy Local `/local` route only; not a Remote option.               |

`--profile-file PATH` is valid only with `--profile`. Otherwise the CLI reads `YANBOT_HARNESS_PROFILE_FILE`, then
`~/.yanbot-harness/profiles.json`.

```json
{
  "schemaVersion": 1,
  "profiles": {
    "daemon": { "mode": "local-daemon", "descriptorPath": "/path/runtime.json" },
    "managed": { "mode": "local-managed", "executablePath": "/path/runtime" },
    "staging": {
      "mode": "remote",
      "origin": "https://runtime.example.com",
      "tokenEnvironment": "YANBOT_HARNESS_ACCESS_TOKEN"
    }
  }
}
```

The file stores only target metadata. `tokenEnvironment` names an environment variable and defaults to
`YANBOT_HARNESS_ACCESS_TOKEN`. Custom names must match `YANBOT_HARNESS_*_ACCESS_TOKEN`, preventing a profile from
forwarding unrelated process secrets. A token value, refresh token, or vendor/model key is an invalid profile field.
The CLI does not accept `--token`.

Local and Remote use the same `adapters`, `models`, `sessions`, `run-status`, and `cancel` commands, JSONL format, and
exit codes. Remote `run` currently returns usage exit `2` after a successful handshake and before creating a Session.
This fail-closed behavior prevents implicit cwd, `--workspace`, and `--cwd` from crossing the Remote boundary while
the public Run request still supports only Local workspace grants. Git references and uploaded snapshots will be
enabled under the same `run` command after Remote workspace preparation is implemented.

Missing profiles, invalid Schema, unavailable credential references, non-HTTPS Remote origins, failed negotiation,
and incompatible protocol versions are terminal errors. The CLI never tries descriptor discovery or managed Local
startup after one of these failures.
