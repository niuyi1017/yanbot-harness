import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { HarnessClient } from '../packages/sdk/dist/index.js';

// Credentials are passed only when --live is explicitly requested. Never print the environment or child output.
const live = process.argv.includes('--live');
if (!process.env.CLAUDE_CODE_EXECUTABLE) throw new Error('Set CLAUDE_CODE_EXECUTABLE to the pinned binary.');
if (live && !process.env.ANTHROPIC_API_KEY_FILE) throw new Error('Live smoke requires ANTHROPIC_API_KEY_FILE.');
const root = await mkdtemp(path.join(tmpdir(), 'harness-claude-runtime-smoke-'));
const descriptorPath = path.join(root, 'state', 'runtime.json');
const workspace = path.join(root, 'workspace');
await mkdir(workspace);
const environment = {
  YANBOT_HARNESS_ADAPTER: 'claude-code-cli',
  YANBOT_HARNESS_STATE_DIR: path.dirname(descriptorPath),
  CLAUDE_CODE_EXECUTABLE: process.env.CLAUDE_CODE_EXECUTABLE,
  ...(live ? { ANTHROPIC_API_KEY_FILE: process.env.ANTHROPIC_API_KEY_FILE } : {}),
  ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  ...(process.env.HARNESS_CLI_JOB_HOST ? { HARNESS_CLI_JOB_HOST: process.env.HARNESS_CLI_JOB_HOST } : {}),
};
const child = spawn(process.execPath, [path.resolve(import.meta.dirname, '../apps/local-runtime/dist/main.js')], {
  env: environment,
  stdio: 'ignore',
  windowsHide: true,
});
const closed = once(child, 'close');
void closed.catch(() => undefined);
try {
  let ready = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child.exitCode !== null) throw new Error('Runtime exited before readiness.');
    try {
      await readFile(descriptorPath);
      ready = true;
      break;
    } catch {
      await delay(100);
    }
  }
  assert(ready, 'Runtime readiness timed out');
  const client = await HarnessClient.connect({ mode: 'local-daemon', descriptorPath });
  const grant = await client.grantWorkspace({ path: workspace });
  const session = await client.createSession({ adapterId: 'com.anthropic.claude-code-cli' });
  const run = await client.createRun(session.sessionId, {
    prompt: 'Return exactly OK.',
    permissionPolicy: 'read-only',
    maxTurns: 1,
    extensions: [],
    configScopes: [],
    resume: false,
    workspace: { kind: 'local-path-grant', workspaceGrant: grant.grant },
  });
  const events = [];
  for await (const event of run.events({ signal: globalThis.AbortSignal.timeout(60_000) })) events.push(event);
  const terminal = events.at(-1);
  if (live) assert.equal(terminal?.type, 'run.completed');
  else {
    assert.equal(terminal?.type, 'run.failed');
    assert.equal(terminal.payload.error.code, 'AUTHENTICATION_FAILED');
  }
  const stored = await run.refresh();
  assert.equal(stored.status, live ? 'completed' : 'failed');
  console.log(
    JSON.stringify({
      status: 'passed',
      evidence: live ? 'live-text' : 'real-cli-no-credentials',
      cliVersion: '2.1.284',
      platform: process.platform,
      arch: process.arch,
      events: events.map((event) => event.type),
      terminalCode: terminal.payload.error?.code,
      usage: events.find((event) => event.type === 'usage.updated')?.payload,
      persistedStatus: stored.status,
    }),
  );
} finally {
  child.kill('SIGTERM');
  const timer = globalThis.setTimeout(() => child.kill('SIGKILL'), 10_000);
  await closed;
  globalThis.clearTimeout(timer);
  await rm(root, { recursive: true, force: true });
}
