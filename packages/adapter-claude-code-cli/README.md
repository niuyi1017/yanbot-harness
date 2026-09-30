# Claude Code CLI Adapter (Experimental)

Pinned CLI: **2.1.284**. Install the vendor CLI independently under its terms, then point the Runtime at its absolute executable path. This package contains the Wrapper, not the vendor binary.

```sh
export YANBOT_HARNESS_ADAPTER=claude-code-cli
export CLAUDE_CODE_EXECUTABLE=/absolute/path/to/claude
export ANTHROPIC_API_KEY_FILE=/absolute/path/to/private-api-key-file
pnpm --filter @yanbot-harness/local-runtime start
```

Key files must be private (`0600` on POSIX). Windows additionally requires `HARNESS_CLI_JOB_HOST` pointing to the compiled native CLI Job host. Keys belong to the Runtime; never place them in SDK requests. An empty credential configuration is allowed for diagnostics and returns `AUTHENTICATION_FAILED` on actual execution.

Use the ordinary SDK and `adapterId: 'com.anthropic.claude-code-cli'`. Select `permissionPolicy: 'read-only'`; tools are disabled. Interactive/auto-edit, extensions, config scopes, resume, model discovery, and sandbox claims are unsupported. Every run has an ephemeral login directory and a default one-turn limit; the CLI receives `--max-budget-usd 0.10` as its soft budget. This is not a guarantee against provider billing overrun.

From the repository after `pnpm build`:

```sh
node scripts/smoke-claude-code-cli.mjs        # deliberately excludes credentials, checks authentication error
node scripts/smoke-claude-code-cli.mjs --live # explicitly uses ANTHROPIC_API_KEY_FILE, checks paid text success
```

The smoke runs through the standalone Runtime and public SDK, checks persisted state, and removes its temporary workspace. It does not print prompts, raw vendor output, or credentials. `--live` is for an authorized test account only.

Upgrade gate: change the exact version only after verifying official package integrity, re-running negative fixtures and the real capability matrix, and checking vendor terms. Unknown versions fail probe; revert the binary/version pair together. Do not auto-update the binary during a run.

Evidence scope: macOS real binary authentication failure and fixture protocol tests; paid success/usage/cancel and real vendor Windows/Linux certification remain pending. POSIX parent SIGKILL containment is not certified; use the managed strong-containment product path where required. See the repository capability matrix and Spec for current gates.
