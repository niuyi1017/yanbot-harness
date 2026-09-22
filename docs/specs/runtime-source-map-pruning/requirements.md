# Runtime source map pruning requirements

## Goal

Produce signed platform Runtime payloads without JavaScript or declaration source maps so downstream desktop packages can preserve their no-source-map release boundary.

## Requirements

1. Runtime normalization must omit every regular file whose portable path ends in `.map`.
2. Omission happens before payload inventory, archive hashing and platform signing; no signed payload may be modified afterward.
3. Normalization evidence must list omitted paths and graph comparison must ignore exactly those paths while continuing to compare executable code, package manifests and resources.
4. Source deploy trees remain immutable; existing destination, link, sensitive-content and unknown virtual-store failures remain fail-closed.
5. Tests cover root and dependency source maps, preserved executable bytes and repeatable normalization.

## Out of scope

- Removing `.d.ts` declarations or runtime JavaScript.
- Changing Runtime protocol, adapter behavior or production signing authorization.
