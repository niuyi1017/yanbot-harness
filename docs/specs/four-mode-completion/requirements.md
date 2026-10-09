# Four-mode remaining development

## Context and authorization

2026-10-09: user authorized completing the four outstanding Harness base development categories continuously. This specification extends the existing four-mode and model-bridge specifications; it does not certify a production release.

## Acceptance criteria

1. Remote Session continuity survives replacement of the Worker/container. State is tenant/session isolated, bounded and expiring; concurrent writers and expired leases cannot overwrite a newer checkpoint. Resume fails explicitly when state is missing or incompatible.
2. Vendor execution supports normalized tool events, permission decisions and user questions through the existing interaction protocol. Broker/channel conversion supports bounded tool requests/results. Unsupported vendor features remain advertised as unsupported.
3. An immutable, allowlisted Git workspace can actually execute remotely. Materialization must reject unsafe paths, links, redirects and unbounded data; credentials never enter the container.
4. CLI users can log in using an already provisioned device, refresh credentials automatically, inspect login status and log out. Secrets are never command arguments, profile fields or output. Credential storage is private, origin bound and serialized across processes.
5. Production configuration has an explicit validated deployment contract for TLS, authenticated Redis/Mongo, upstream policies and shared state. Recovery tests cover worker loss and fencing with multiple workers. Enabling a flag alone is not release certification.
6. Relevant unit/integration tests and real vendor synthetic-upstream tests pass. CI Docker/Mongo evidence is archived against the implementation commit.

## Constraints / exclusions

No production credentials or deployment are requested. Paid model validation, actual Windows 10/11 host certification, signing, registry publication and licensing approval remain external release gates. No Showcase business changes, Web/Electron/Admin UI or marketplace. Preserve unrelated user documentation edits. No model Key is currently available.
