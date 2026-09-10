# SDK/CLI Local Preview Handoff

## Artifact set

The development candidate is generated under `release/0.1.0-preview.2/`:

- `packages/yanbot-harness-contracts-0.1.0-preview.2.tgz`
- `packages/yanbot-harness-sdk-0.1.0-preview.2.tgz`
- `packages/yanbot-harness-cli-0.1.0-preview.2.tgz`
- `packages/zod-4.4.3.tgz` for offline installation
- `runtime/yanbot-harness-runtime-0.1.0-preview.2-<platform>-<arch>.tar.gz`
- `manifest.json` and `SHA256SUMS`
- `QUICKSTART.md`, `RELEASE_NOTES.md`, compatibility and capability documents

Always take the exact hashes from `SHA256SUMS`; do not copy a hash from chat or an earlier build.

## Acceptance evidence

- Full workspace gate: 122 tests plus formatting, lint, package boundaries, build, and typecheck.
- Clean-room Reference: offline repo-independent installation; SDK text/interaction/cancel; CLI
  text/JSONL/resume/cancel; SDK-owned and CLI-owned managed startup; descriptor mode and cleanup verified.
- Packaged CodeBuddy re-certification for `preview.2` is pending formal key rotation. The previous immutable
  `preview.1` candidate passed SDK initial/resume/cancel and CLI JSONL with the vendor key excluded from SDK/CLI
  process environments.
- Artifact inspection: public production dependency allowlists, checksum verification, and scans for credential-like
  values, `.env`, keys/certificates, source maps, workspace protocols, internal source/tests, and local paths.

## Consumer sign-off flow

1. Verify `SHA256SUMS`.
2. Follow `QUICKSTART.md` to install all package tarballs offline.
3. Start the Runtime in `--reference` mode and run one SDK and one CLI request.
4. Repeat with SDK `startManagedRuntime()` and CLI `--managed-runtime`, then confirm the owned Runtime and temporary
   descriptor directory are gone.
5. Confirm SDK/CLI import only public packages and do not receive a CodeBuddy key in Daemon/external mode.
6. For the controlled production check, inject a current key only into the Runtime and use the `internal` route.
7. Stop the Runtime and confirm the descriptor and child processes are gone.

## Known limits and rollback

- CodeBuddy model discovery is disabled because SDK 0.3.254 does not reliably release its CLI process.
- CodeBuddy tool/permission/question scenarios have fixture coverage but are not real-certified.
- Windows, browser clients, cloud multi-tenancy, Web/Electron/Admin, MCP, skills, agents, and hooks are not included.
- To roll back, stop distributing this candidate and restore the previous checksum-verified version directory. If a
  credential was exposed, revoke or rotate it separately; reverting artifacts does not invalidate credentials.
