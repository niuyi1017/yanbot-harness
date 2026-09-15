# Installed Runtime resolver

Preview.3 implementation candidate. Resolves a matching installed platform package, verifies an Ed25519-signed manifest and file inventory, and extracts only into a private versioned cache. No downloads or lifecycle hooks.

Production trust roots are intentionally empty pending release authorization. `trustedKeys` is an explicit host trust decision, not a key loaded from the payload. Test keys do not establish production certification. See the unified local distribution Spec for remaining platform and lifecycle gates.
