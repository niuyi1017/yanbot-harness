# Runtime target and CLI profile migration

The preview.3 development candidate keeps one SDK and CLI surface for Local and Remote Runtime targets. Phase 4 now
contains the Cloud control plane, explicit Remote workspace preparation, deployment-side organization admission,
Redis relay, and an independent credential-free Reference Worker. These are source/test candidates, not a hosted Remote deployment or interactive login. Current
release certification remains Local-only.

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

Local and Remote use the same `adapters`, `models`, `sessions`, `run-status`, `cancel`, and `run` commands, JSONL
format, and exit codes. Remote `run` requires exactly one explicit preparation source:

```bash
yanbot-harness run "Check this tree" --remote https://runtime.example.com --snapshot ./workspace
yanbot-harness run "Check this commit" --remote https://runtime.example.com \
  --git-repository https://github.com/example/repo.git --git-commit <40-lowercase-hex-commit>
```

`--snapshot` serializes regular files only, omits `.git`, rejects symlinks and secret-key paths, and is subject to the
public snapshot limits. Git registration accepts only a server-allowlisted credential-free HTTPS origin and an
immutable commit. The implicit cwd, Local `--workspace`, and Local `--cwd` are never sent to a Remote target. A
control-plane-only deployment leaves the resulting Run queued until the Phase 4 Reference Worker is attached. Git
execution remains rejected by that Worker until the Phase 5 isolated Sandbox exists.

Missing profiles, invalid Schema, unavailable credential references, non-HTTPS Remote origins, failed negotiation,
and incompatible protocol versions are terminal errors. The CLI never tries descriptor discovery or managed Local
startup after one of these failures.
