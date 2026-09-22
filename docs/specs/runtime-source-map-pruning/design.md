# Runtime source map pruning design

`normalizeRuntimeStaging` already owns the immutable source-to-candidate copy plan. It will classify `.map` files as omitted alongside known package-manager metadata, retain their paths in normalization evidence, and verify they do not appear in the normalized candidate.

`stageRuntime` will pass the exact normalization omission list to both deployment-graph audits. This keeps dependency/resource graph equivalence meaningful while excluding bytes intentionally removed by the normalization policy. `buildPlatformPackage` then inventories, archives and signs the already-pruned candidate, so manifest payload and file-list hashes cover the final bytes without a post-sign transformation.

Rollback is a two-line policy reversal: remove the `.map` omission classification and the dynamic graph-ignore entries. No source tree or prior artifact is mutated.
