# @yanbot-harness/cli

Distribution boundary: this Preview CLI stays SDK-only. Local managed mode requires an explicit installed Runtime;
Remote mode never resolves or starts one. The `@yanbot-harness/local` SDK entry does not make this CLI auto-install
or auto-discover a Runtime. Future default local startup and Daemon management commands require their own acceptance
gate.

Node.js 22 command-line client for a Yanbot Harness Runtime.

```bash
yanbot-harness --version
yanbot-harness adapters --json
yanbot-harness run "Reply with a delivery check" --json --log-level silent
```

By default the CLI discovers the mode-0600 local Runtime descriptor. New connections use neutral `/v1` routes and
an explicit target selected by `--descriptor`, `--managed-runtime`, `--remote`, or `--profile`. Target options are
mutually exclusive. `--runtime` remains a loopback-only legacy `/local` migration option. There is deliberately no
token or CodeBuddy key command-line option.

Use `--managed-runtime PATH` to start an already installed Runtime only for the current command. The CLI waits for
the protected descriptor and health response, then shuts down the owned Runtime and removes its temporary state on
every exit path. The option is mutually exclusive with `--descriptor` and `--runtime`; it never downloads or updates
the executable. `--remote HTTPS_URL` uses `YANBOT_HARNESS_ACCESS_TOKEN` and never falls back to a Local target.

Profiles are versioned JSON selected with `--profile NAME [--profile-file PATH]`. The default file is
`YANBOT_HARNESS_PROFILE_FILE` or `~/.yanbot-harness/profiles.json`. Profiles store only target metadata and an
environment-variable name, never a token:

```json
{
  "schemaVersion": 1,
  "profiles": {
    "local": { "mode": "local-daemon", "descriptorPath": "/path/runtime.json" },
    "remote": {
      "mode": "remote",
      "origin": "https://runtime.example.com",
      "tokenEnvironment": "YANBOT_HARNESS_ACCESS_TOKEN"
    }
  }
}
```

Remote read/control commands use the same names and output as Local. Remote `run` requires `--snapshot PATH` or the
pair `--git-repository HTTPS_URL --git-commit SHA`; it never sends the implicit cwd, Local `--workspace`, or `--cwd`
to a Remote Runtime. See the [target/profile migration guide](../../docs/delivery/runtime-target-profiles.md).

Commands are `run`, `adapters`, `models`, `sessions`, `run-status`, and `cancel`. `run --json` emits a
`cli.run-created` record followed by public Adapter events, one JSON value per stdout line; diagnostics remain on
stderr. In text mode a TTY can answer permission/question interactions. JSON/non-TTY mode returns exit code `11`
when caller interaction is required.

Exit codes: `0` success, `2` usage, `10` cancelled/timeout, `11` interaction/permission, `20` authentication, `30`
Adapter/upstream, `40` Runtime/network/protocol.

The CLI depends on the SDK and the shared workspace-snapshot serializer. It requires a separately delivered Runtime
and never imports an Adapter or vendor SDK.

## Remote login

Use an administrator-provisioned device identity:

```sh
yanbot-harness login --remote https://runtime.example.test --organization ORGANIZATION_UUID --device DEVICE_UUID
yanbot-harness auth-status --remote https://runtime.example.test --json
yanbot-harness logout --remote https://runtime.example.test
```

Login reads a masked device secret from the terminal. Automation can supply
`YANBOT_HARNESS_DEVICE_SECRET`; never put the secret on the command line. An
explicit Remote `--profile` works for all three commands. Credentials are saved
per origin in `~/.yanbot-harness/credentials` (override:
`YANBOT_HARNESS_CREDENTIALS_DIRECTORY`). POSIX storage requires the current owner
and private permissions; Windows verifies a private current-user ACL. Existing
unsafe directories are rejected. Access tokens supplied through the profile's
environment variable take precedence over saved login.

Token refresh is serialized across CLI processes. A crashed process may leave an
origin-specific `.lock` file: verify its recorded PID is no longer running before
removing it. A refresh interrupted after the server rotates the token may require
logout and login again. Logout revokes the complete token family remotely before
removing local credentials; if the service is unavailable, the local record is
retained so revocation can be retried. `auth-status` reports local refresh expiry;
it does not prove that the server still accepts the identity.
