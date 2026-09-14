# SDK/CLI Local Preview Handoff

## Artifact set

The downloadable candidates are generated beside the expanded release directory:

- `release/yanbot-harness-0.1.0-preview.2-darwin-arm64.zip` plus `.zip.sha256`
- `release/yanbot-harness-0.1.0-preview.2-win32-x64.zip` plus `.zip.sha256`

Each outer ZIP contains one platform-named directory with:

- `packages/yanbot-harness-contracts-0.1.0-preview.2.tgz`
- `packages/yanbot-harness-sdk-0.1.0-preview.2.tgz`
- `packages/yanbot-harness-cli-0.1.0-preview.2.tgz`
- `packages/zod-4.4.3.tgz` for offline installation
- `runtime/yanbot-harness-runtime-0.1.0-preview.2-<platform>-<arch>.tar.gz` on macOS/Linux
- `runtime/yanbot-harness-runtime-0.1.0-preview.2-win32-x64.zip` on Windows
- `manifest.json` and `SHA256SUMS`
- `QUICKSTART.md`, `RELEASE_NOTES.md`, compatibility and capability documents
- `windows-sdk-cli-integration-guide.zh-CN.md`, a Windows 10/11 install-to-integration and acceptance guide

Always take the exact hashes from `SHA256SUMS`; do not copy a hash from chat or an earlier build.
Verify the outer `.zip.sha256` before extraction, then verify the enclosed `SHA256SUMS`. The contracts, SDK, CLI,
and Zod tgz hashes must be identical in the macOS and Windows manifests because both candidates consume the same CI
common-package artifact.

## Acceptance evidence

- Full workspace gate: 136 tests plus formatting, lint, package boundaries, build, and typecheck.
- Clean-room Reference: offline repo-independent installation; SDK text/interaction/cancel; CLI
  text/JSONL/resume/cancel; SDK-owned and CLI-owned managed startup; descriptor mode and cleanup verified.
- GitHub-hosted Windows Server 2022 x64 Reference release CI passed on commit `095836d`; the run publishes the
  `yanbot-harness-win32-x64` candidate and does not claim Windows 10/11 desktop certification:
  <https://github.com/niuyi1017/yanbot-harness/actions/runs/34822049540>.
- The same run built public packages once, assembled them unchanged into all platform candidates, and passed the
  cross-platform package-hash comparison.
- On 2026-09-14, the clean commit `095836d` macOS arm64 `preview.2` candidate passed packaged CodeBuddy SDK
  initial/resume/cancel, CLI JSONL, and zero-child-process checks. Only the Runtime test process received the
  credential; the recorded output contained only the version, scenario names, and child-process count.
- Windows packaged CodeBuddy re-certification remains pending the protected manual workflow, and Windows 10/11
  desktop acceptance remains pending a tester machine.
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
8. On Windows 10/11, complete `windows-sdk-cli-integration-guide.zh-CN.md` and return only its non-sensitive result
   template.

## Protected Windows CodeBuddy gate

Repository administrators configure the `internal-preview-codebuddy` GitHub Environment with required reviewers and
an Environment Secret named `CODEBUDDY_API_KEY`. Do not configure this as a repository-wide secret. After a normal
CI run succeeds for the candidate commit, manually dispatch `Windows CodeBuddy Certification` on that exact ref and
enter the successful CI run ID. The workflow downloads the already-built `yanbot-harness-win32-x64` artifact,
requires a clean manifest for the same commit, and exposes the Key only to the packaged CodeBuddy test step. Ordinary
push and pull-request workflows cannot invoke this gate or read its Secret.

## Known limits and rollback

- CodeBuddy model discovery is disabled because SDK 0.3.254 does not reliably release its CLI process.
- CodeBuddy tool/permission/question scenarios have fixture coverage but are not real-certified.
- Windows arm64, native `.exe`/MSI installers, browser clients, cloud multi-tenancy, Web/Electron/Admin, MCP,
  skills, agents, and hooks are not included.
- Windows x64 must remain a candidate until both the Windows Reference CI and a Windows real CodeBuddy run pass.
- To roll back, stop distributing this candidate and restore the previous checksum-verified version directory. If a
  credential was exposed, revoke or rotate it separately; reverting artifacts does not invalidate credentials.
