# Yanbot Harness

Yanbot Harness is a business-neutral agent runtime built around a stable adapter protocol. CodeBuddy is the first
production adapter; future harnesses can integrate without changing the public SDK or clients.

The repository is currently implementing the `foundation-bootstrap` specification: contracts, adapter SPI,
reference adapter, conformance tests, and the CodeBuddy compatibility probe. Local Web, Electron, Admin, and cloud
execution are intentionally not scaffolded yet.

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

## Package boundaries

- `packages/contracts`: JSON-serializable schemas and public protocol types.
- `packages/adapter-api`: vendor-neutral adapter lifecycle and registry.
- `packages/harness-core`: runtime orchestration over the adapter API.
- `packages/adapter-kit`: adapter authoring helpers and conformance checks.
- `packages/adapter-reference`: deterministic, offline reference implementation.
- `packages/adapter-codebuddy`: CodeBuddy 0.3.43 translation and the only package allowed to import its vendor SDK.
- `packages/adapter-sidecar`: protocol schemas only during the foundation phase.

See [the foundation specification](docs/specs/foundation-bootstrap/design.md) for the current implementation contract.
Adapter authors should also read [Adapter Protocol 1.0](docs/architecture/adapter-protocol.md).
