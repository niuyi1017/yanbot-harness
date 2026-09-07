# Yanbot Harness

Yanbot Harness is a business-neutral agent runtime built around a stable adapter protocol. CodeBuddy is the first
production adapter; future harnesses can integrate without changing the public SDK or clients.

The foundation and M2 Local Runtime are complete for offline development: contracts, adapter SPI, managed runs,
local persistence, authentication, workspace grants, configuration, extension discovery, loopback lifecycle, and
the HTTP/SSE API are covered by Reference Adapter black-box tests. M3 SDK/CLI work can now begin after its child Spec
is established. The real CodeBuddy probe remains pending until an explicit credentialed environment is provided and
is still required before a production-ready claim. Local Web, Electron, Admin, and cloud execution are not
scaffolded yet.

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
- `apps/local-runtime`: loopback-only HTTP/SSE service, local state, authentication, workspace grants, and run
  supervision.

See [the foundation specification](docs/specs/foundation-bootstrap/design.md) for the current implementation contract.
Adapter authors should also read [Adapter Protocol 1.0](docs/architecture/adapter-protocol.md).
