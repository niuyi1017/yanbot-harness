# CodeBuddy Runtime Hardening Tasks

Implementation status: CRH-T1 through CRH-T5 are complete. The offline gate passes. On 2026-09-09 the controlled real
vendor gate completed initial, resume, cancellation, and usage with natural process cleanup and no active child
process. The credential remains an operator-owned development credential and is not stored in this repository.

## CRH-T1 — Record the compatibility baseline

- Files: `requirements.md`, `design.md`, `tasks.md`
- Dependency: none
- Work: document the reproduced 401/missing-result chain, explicit scope, lifecycle semantics, and vendor version.
- Verification: the three Spec documents exist under this feature directory before implementation changes.

## CRH-T2 — Upgrade the isolated vendor dependency

- Files: `packages/adapter-codebuddy/package.json`, `pnpm-lock.yaml`, adapter metadata/documentation
- Dependency: CRH-T1
- Work: pin SDK `0.3.254`, refresh the lockfile, update reported compatibility metadata, and resolve public API type
  changes without leaking vendor types outside the adapter.
- Verification: adapter build and package-boundary checks pass.

## CRH-T3 — Harden terminal, timeout, and cancellation behavior

- Files: `packages/adapter-codebuddy/src/index.ts`, `packages/adapter-codebuddy/src/sdk-facade.ts`
- Dependency: CRH-T2
- Work: add single-terminal guarding, wall/idle watchdogs, legacy 401 recognition, bounded stop operations, and prompt
  cancellation completion.
- Verification: targeted adapter tests demonstrate that a non-yielding stream cannot hold the Harness event stream
  open indefinitely.

## CRH-T4 — Add lifecycle regression coverage

- Files: `packages/adapter-codebuddy/test/codebuddy.test.ts`
- Dependency: CRH-T3
- Work: cover legacy assistant-form 401, thrown 401, wall/idle timeout, non-responsive interrupt, cancellation, missing
  result, normal success, and redaction.
- Verification: `pnpm --filter @yanbot-harness/adapter-codebuddy test:unit` passes.

## CRH-T5 — Verify and hand off credential work

- Files: `README.md`, `docs/architecture/codebuddy-capability-matrix.md`, this task file
- Dependency: CRH-T2 through CRH-T4
- Work: run the complete offline gate, retain the historical 401 compatibility evidence, and record the successful
  credentialed core probe without recording the credential.
- Verification: `pnpm check` and the controlled initial/resume/cancel smoke pass; model listing and advanced tool/
  interaction scenarios remain conservatively downgraded where real lifecycle evidence is incomplete.
