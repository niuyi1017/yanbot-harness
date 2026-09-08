# Yanbot Harness

Yanbot Harness is a business-neutral agent runtime built around a stable adapter protocol. CodeBuddy is the first
production adapter; future harnesses can integrate without changing the public SDK or clients.

The foundation, M2 Local Runtime, and M3 TypeScript SDK/CLI are complete for offline development. Contracts, adapter
SPI, managed runs, local persistence, authentication, workspace grants, configuration, extension discovery,
loopback lifecycle, HTTP/SSE, the public SDK, and CLI process boundary are covered by Reference Adapter black-box
tests. The real CodeBuddy probe remains pending until an explicit credentialed environment is provided and is still
required before a production-ready claim. Local Web, Electron, Admin, and cloud execution are not scaffolded yet.

## Requirements

- Node.js >=22.22.0 <23 (CI uses 22.22.0)
- Corepack
- pnpm 11.10.0

## Commands

```bash
corepack enable
pnpm install
pnpm check
pnpm build
```

`pnpm check` performs formatting, linting, package-boundary checks, type checking, tests, and builds. Real CodeBuddy
smoke tests are opt-in through `pnpm smoke:codebuddy`; default CI never requires a model credential.

## Offline third-party simulation

Build the workspace, start a credential-free Reference Runtime, and call it from another terminal through the CLI:

```bash
pnpm build
pnpm --filter @yanbot-harness/local-runtime start:reference
```

```bash
pnpm --filter @yanbot-harness/cli start run "Simulate a third-party call" --json --log-level silent
```

The second command discovers `~/.yanbot-harness/runtime.json`, uses its protected bearer credential, grants the
current workspace, creates a Session and Run, then emits the public event stream as JSONL. It does not import the
Reference Adapter or call any vendor SDK from the CLI process.

## TypeScript SDK

`@yanbot-harness/sdk` connects to an explicit endpoint, an embedded Runtime handle, or a standalone daemon:

```ts
import { HarnessClient } from '@yanbot-harness/sdk';

const client = await HarnessClient.fromDaemon();
const grant = await client.grantWorkspace({ path: process.cwd() });
const session = await client.createSession({ adapterId: 'cn.yanbot.reference' });
const run = await client.createRun(session.sessionId, {
  prompt: 'Inspect this workspace.',
  workspaceGrant: grant.grant,
  permissionPolicy: 'read-only',
  configScopes: [],
  extensions: [],
  resume: false,
});

for await (const event of run.events()) console.log(event);
```

See `examples/sdk-basic` for the buildable version. The example depends only on the public SDK.

## CLI

Run `pnpm --filter @yanbot-harness/cli start --help` for all commands. The CLI provides `run`, `adapters`,
`models`, `sessions`, `run-status`, and `cancel`, with human-readable and `--json` JSONL modes.

Connection credentials are resolved in this order:

1. `--runtime URL` with `YANBOT_HARNESS_ACCESS_TOKEN`.
2. `--descriptor PATH`.
3. `YANBOT_HARNESS_RUNTIME_DESCRIPTOR`.
4. `~/.yanbot-harness/runtime.json`.

There is deliberately no token command-line option. Exit codes are `0` success, `2` usage, `10` cancellation,
`11` denied or unhandled interaction, `20` authentication, `30` adapter/upstream failure, and `40` Runtime/network/
protocol failure. `--log-level` accepts `silent`, `error`, `info`, or `debug`; machine-readable records remain on
stdout and diagnostics remain on stderr.

## Local Runtime

Build and start the standalone loopback service with:

```bash
pnpm build
pnpm --filter @yanbot-harness/local-runtime start
```

It listens on a random `127.0.0.1` port and writes a mode-`0600` startup descriptor to
`~/.yanbot-harness/runtime.json`. The descriptor is removed during a normal shutdown. Override the state directory
with `YANBOT_HARNESS_STATE_DIR`; optionally inject an access token with `YANBOT_HARNESS_ACCESS_TOKEN` and a
comma-separated browser Origin allowlist with `YANBOT_HARNESS_ALLOWED_ORIGINS`. These values are never printed.

Adapter credentials are not accepted over HTTP. The standalone CodeBuddy adapter only resolves
`CODEBUDDY_API_KEY` from its allowlisted process environment. Without that explicit credential, offline runtime and
Reference Adapter tests still pass, while real CodeBuddy model calls remain unavailable.

## Package boundaries

- `packages/contracts`: JSON-serializable schemas and public protocol types.
- `packages/adapter-api`: vendor-neutral adapter lifecycle and registry.
- `packages/harness-core`: runtime orchestration over the adapter API.
- `packages/adapter-kit`: adapter authoring helpers and conformance checks.
- `packages/adapter-reference`: deterministic, offline reference implementation.
- `packages/adapter-codebuddy`: CodeBuddy 0.3.43 translation and the only package allowed to import its vendor SDK.
- `packages/adapter-sidecar`: protocol schemas only during the foundation phase.
- `packages/testing`: deterministic clocks/IDs and the black-box Local Runtime test client.
- `packages/sdk`: stable TypeScript client for the public HTTP/SSE protocol and protected daemon discovery.
- `apps/local-runtime`: loopback-only HTTP/SSE service, local state, authentication, workspace grants, and run
  supervision.
- `apps/cli`: terminal client built exclusively on `packages/sdk`.

See [the foundation specification](docs/specs/foundation-bootstrap/design.md) for the current implementation contract.
Adapter authors should also read [Adapter Protocol 1.0](docs/architecture/adapter-protocol.md).
