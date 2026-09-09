# CodeBuddy Capability Matrix

This matrix tracks three different evidence levels for `@tencent-ai/agent-sdk` 0.3.254. “Documented” means the SDK
declarations or official SDK documentation expose the behavior. “Fixture” means ordinary CI verifies the Yanbot
normalization path without network access. “Real” requires the explicit `pnpm smoke:codebuddy` probe in a controlled
credentialed environment.

| Capability                 | Adapter level                     | Documented evidence                                    | Fixture evidence                                   | Real probe                  |
| -------------------------- | --------------------------------- | ------------------------------------------------------ | -------------------------------------------------- | --------------------------- |
| Text streaming             | native                            | `stream_event` and text/thinking delta types           | covered                                            | real-verified               |
| Complete assistant message | native                            | assistant content blocks                               | covered                                            | real-verified               |
| Tool lifecycle             | native                            | assistant `tool_use` and embedded `tool_result` blocks | embedded, top-level, and duplicate results covered | unverified                  |
| Session resume             | native                            | `query({ options: { resume } })`                       | option mapping covered                             | real-verified               |
| Cancellation               | native                            | `Query.interrupt()` and `AbortController`              | bounded non-responsive path covered                | real-verified               |
| Permission interaction     | native                            | `canUseTool` callback                                  | allow, deny policy, and correlation covered        | unverified                  |
| Question interaction       | native                            | `AskUserQuestion` through `canUseTool`                 | answer mapping covered                             | unverified                  |
| Model list                 | unsupported in Preview            | SDK exposes two model discovery APIs                   | response mapping covered                           | returned 15; cleanup failed |
| Token usage                | native                            | result `usage` fields                                  | covered                                            | real-verified               |
| Cost usage                 | native                            | result `total_cost_usd`                                | covered                                            | real-verified               |
| Configuration sources      | native                            | `user`, `project`, and `local` setting sources         | platform-scope mapping covered                     | internal route verified     |
| MCP                        | unsupported in foundation adapter | SDK exposes MCP options/status                         | intentionally deferred                             | pending                     |
| Skills/commands            | unsupported in foundation adapter | SDK exposes command discovery                          | intentionally deferred                             | pending                     |
| Agents                     | unsupported in foundation adapter | SDK exposes agent options                              | intentionally deferred                             | pending                     |
| Hooks                      | unsupported in foundation adapter | SDK exposes hook callbacks                             | intentionally deferred                             | pending                     |

## Compatibility notes

- Public policies map inside the adapter: `interactive` → `default`, `auto-edit` → `acceptEdits`, and `read-only` →
  `plan`. The adapter never enables `bypassPermissions`.
- `organization` is a platform configuration scope and is not forwarded as a CodeBuddy setting source.
- The adapter constructs an explicit environment allowlist. It does not spread `process.env`; internal routing does
  not receive an explicit base URL.
- Top-level `tool_result` is retained as a compatibility path because the existing Yanbot Teacher runtime has
  observed it, although it is not part of the SDK 0.3.254 `Message` union.
- A stream ending without `result` becomes `HARNESS_PROTOCOL_ERROR`; it is not reported as success. A run that
  exceeds the 30-minute wall deadline or remains vendor-idle for 2 minutes becomes `RUN_TIMEOUT`. Both values are
  adapter-configurable.
- SDK `0.3.43` represented a real 401 as assistant content and then omitted `result`. The adapter recognizes this
  legacy signal as `AUTHENTICATION_FAILED`; SDK `0.3.254` also throws a typed execution error for the same response.
- SDK `0.3.254` model discovery returned 15 schema-valid models in a controlled probe, but its V2 Session left a CLI
  subprocess alive after public `close()`. The Query control API could be closed but did not return the model list
  reliably. `models.list` is therefore explicitly unsupported in this Preview instead of shipping a known leak.

## Running the controlled probe

Set `CODEBUDDY_API_KEY` and optionally `CODEBUDDY_INTERNET_ENVIRONMENT`, `CODEBUDDY_BASE_URL`,
`CODEBUDDY_CODE_PATH`, and `CODEBUDDY_MODEL`, then run:

```bash
pnpm smoke:codebuddy
```

The probe creates and removes a temporary workspace, prints event type summaries only, and redacts the credential
from failures. It performs an initial run, a resume, and a cancellation. Tool, permission, question, MCP, skill,
agent, and hook behavior still require a separately controlled scenario before their “Real probe” cells can be
marked verified.

On 2026-09-08 an older controlled credential was rejected with HTTP 401. On 2026-09-09 an explicitly authorized
development credential with the internal routing profile completed initial, resume, cancellation, token usage, and
cost usage probes. After fixing the Query iterator cleanup, the core probe exited naturally with no active child
process. No credential value was logged or copied into this repository. Tool, permission, and question scenarios
remain unverified; they are not presented as real-certified delivery capabilities.

On 2026-09-10 the same core scenarios were repeated through the final `0.1.0-preview.1` tarballs and portable Runtime
archive from a repository-independent consumer directory. SDK initial/resume/cancel and CLI JSONL completed, the
SDK/CLI processes did not receive the vendor credential, and the Runtime had no remaining CodeBuddy child process.

## Sources

- [CodeBuddy Agent SDK documentation](https://www.codebuddy.cn/docs/cli/sdk)
- SDK 0.3.254 declarations installed by the repository lockfile
- [CodeBuddy public changelog](https://cnb.cool/codebuddy/codebuddy-code/-/blob/main/CHANGELOG.md)
- Existing `yanbot-teacher/apps/local-runtime` integration (read-only implementation reference)
