# Local installation facade

Preview.3 candidate: re-exports the lightweight SDK and supplies a verified installed-Runtime resolver only when managed startup is requested. Production distribution remains gated on release trust, Registry, vendor redistribution and platform certification.

Use `startManagedRuntime({ reference: true })` after installing a complete authorized release. The default environment excludes Registry tokens, inline credentials and Node injection variables. Explicit `environment` is an advanced host trust decision; protected `CODEBUDDY_API_KEY_FILE` is recommended.
