# @yanbot-harness/contracts

Public Zod schemas and TypeScript types for Harness protocol `1.0.0`.

The canonical public resources are `Session`, `Run`, `CreateSessionRequest`, and `CreateRunRequest`. Preview-era
`Local*` schemas and types are deprecated identity aliases and remain available through at least
`0.1.0-preview.5`. Runtime deployment capabilities are described separately by `RuntimeProfile` and
`WorkspaceSource`; adapter capabilities remain vendor/model-facing.

`CreateRunRequest` accepts either the preview-compatible top-level `workspaceGrant` / `relativeCwd` fields or a
single `workspace: WorkspaceSource` field. New integrations should use `workspace`; the two forms cannot be mixed.
Local Runtime accepts `local-path-grant`, while Remote Runtime capabilities determine whether `git-ref` or
`uploaded-snapshot` is supported.

This package contains no Runtime, Adapter, vendor SDK, or credential. It is normally installed transitively by
`@yanbot-harness/sdk`.
