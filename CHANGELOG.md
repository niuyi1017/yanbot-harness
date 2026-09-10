# Changelog

## 0.1.0-preview.2 - Unreleased

- Add explicit SDK-owned Runtime startup with descriptor/health readiness, bounded failure, idempotent shutdown, and
  temporary state cleanup.
- Add CLI `--managed-runtime` for an ephemeral Runtime owned by one command while preserving external and Daemon
  connection modes.
- Extend workspace and clean-room Reference coverage to managed SDK/CLI lifecycle paths.
- Preserve `0.1.0-preview.1` artifacts as the immutable previous candidate; CodeBuddy real-runtime certification
  must be repeated before `preview.2` is signed off.

## 0.1.0-preview.1 - 2026-09-09

- Deliver installable contracts, TypeScript SDK, and CLI artifacts with a portable Local Runtime companion.
- Freeze Harness protocol `1.0.0`, Node 22, and CodeBuddy Agent SDK `0.3.254` compatibility.
- Verify Reference Adapter SDK/CLI flows and controlled CodeBuddy initial, resume, cancellation, streaming, and usage.
- Close the actual CodeBuddy query iterator so successful vendor CLI subprocesses terminate naturally.
- Mark CodeBuddy model discovery unsupported in this Preview because the vendor API does not reliably release its
  CLI subprocess; tool/permission/question scenarios remain real-unverified.
- Keep CodeBuddy credentials inside the Runtime process; release artifacts contain no credentials or local state.
