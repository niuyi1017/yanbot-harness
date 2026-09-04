# CodeBuddy Capability Matrix

This matrix tracks three different evidence levels for `@tencent-ai/agent-sdk` 0.3.43. “Documented” means the SDK
declarations or official SDK documentation expose the behavior. “Fixture” means ordinary CI verifies the Yanbot
normalization path without network access. “Real” requires the explicit `pnpm smoke:codebuddy` probe in a controlled
credentialed environment.

| Capability                 | Adapter level                     | Documented evidence                                    | Fixture evidence                                   | Real probe                  |
| -------------------------- | --------------------------------- | ------------------------------------------------------ | -------------------------------------------------- | --------------------------- |
| Text streaming             | native                            | `stream_event` and text/thinking delta types           | covered                                            | pending                     |
| Complete assistant message | native                            | assistant content blocks                               | covered                                            | pending                     |
| Tool lifecycle             | native                            | assistant `tool_use` and embedded `tool_result` blocks | embedded, top-level, and duplicate results covered | pending                     |
| Session resume             | native                            | `query({ options: { resume } })`                       | option mapping covered                             | scripted, pending execution |
| Cancellation               | native                            | `Query.interrupt()` and `AbortController`              | covered                                            | scripted, pending execution |
| Permission interaction     | native                            | `canUseTool` callback                                  | allow, deny policy, and correlation covered        | pending                     |
| Question interaction       | native                            | `AskUserQuestion` through `canUseTool`                 | answer mapping covered                             | pending                     |
| Model list                 | native                            | `unstable_v2_createSession().getAvailableModels()`     | facade mapping covered                             | pending                     |
| Token usage                | native                            | result `usage` fields                                  | covered                                            | pending                     |
| Cost usage                 | native                            | result `total_cost_usd`                                | covered                                            | pending                     |
| Configuration sources      | native                            | `user`, `project`, and `local` setting sources         | platform-scope mapping covered                     | pending                     |
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
  observed it, although it is not part of the SDK 0.3.43 `Message` union.
- A stream ending without `result` becomes `HARNESS_PROTOCOL_ERROR`; it is not reported as success.

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

## Sources

- [CodeBuddy Agent SDK documentation](https://www.codebuddy.cn/docs/cli/sdk)
- SDK 0.3.43 declarations installed by the repository lockfile
- Existing `yanbot-teacher/apps/local-runtime` integration (read-only implementation reference)
