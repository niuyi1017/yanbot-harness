# @yanbot-harness/contracts

Public Zod schemas and TypeScript types for Harness protocol `1.0.0`.

The canonical public resources are `Session`, `Run`, `CreateSessionRequest`, and `CreateRunRequest`. Preview-era
`Local*` schemas and types are deprecated identity aliases and remain available through at least
`0.1.0-preview.5`. Runtime deployment capabilities are described separately by `RuntimeProfile` and
`WorkspaceSource`; adapter capabilities remain vendor/model-facing.

This package contains no Runtime, Adapter, vendor SDK, or credential. It is normally installed transitively by
`@yanbot-harness/sdk`.
