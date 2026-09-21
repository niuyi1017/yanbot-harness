import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { CodeBuddyAdapter } from '../dist/index.js';

// Explicitly opt-in and bounded; never imports production server-info or prints model output/configuration.
const report = {
  schemaVersion: 1,
  kind: 'codebuddy-extension-live-probe',
  platform: process.platform,
  architecture: process.arch,
  sdkVersion: '0.3.254',
  status: 'blocked',
  capabilityPromotionAllowed: false,
  remainingReleaseProofs: ['unselected-live-canary', 'target-platform-artifact-consumer', 'full-release-gate'],
  cases: [],
};
let root;
try {
  if (process.env.HARNESS_CODEBUDDY_EXTENSION_PROBE !== '1') throw new Error('OPT_IN_REQUIRED');
  let credential = process.env.CODEBUDDY_API_KEY;
  if (!credential && process.env.CODEBUDDY_API_KEY_FILE) {
    const info = await stat(process.env.CODEBUDDY_API_KEY_FILE);
    if (info.size > 16384 || (process.platform !== 'win32' && (info.mode & 0o077) !== 0))
      throw new Error('PRIVATE_CREDENTIAL_FILE_REQUIRED');
    credential = (await readFile(process.env.CODEBUDDY_API_KEY_FILE, 'utf8')).trim();
  }
  if (!credential) throw new Error('TEST_CREDENTIAL_REQUIRED');
  root = await mkdtemp(path.join(tmpdir(), 'harness-cee-live-'));
  const cwd = path.join(root, 'workspace');
  await mkdir(cwd);
  const pidFile = path.join(root, 'fixture-pids.txt');
  const canary = randomBytes(24).toString('hex');
  const hash = (value) => createHash('sha256').update(value).digest('hex');
  const content =
    '---\nname: cee-fixture\ndescription: Harmless extension integration probe.\n---\nCall the fixture_read MCP tool, then use AskUserQuestion to ask whether the probe should finish. After an answer, output CEE_SKILL_OK. Never read other files or call other tools.\n';
  const snapshots = [
    {
      kind: 'skill',
      extensionId: 'cee-fixture',
      version: '1.0.0',
      source: 'bundled',
      descriptorDigest: hash('skill'),
      contentDigest: hash(content),
      resource: { files: [{ path: 'SKILL.md', content, bytes: Buffer.byteLength(content), digest: hash(content) }] },
    },
    {
      kind: 'mcp',
      extensionId: 'mcp.cee-fixture',
      version: '1.0.0',
      source: 'bundled',
      descriptorDigest: hash('mcp'),
      contentDigest: hash('mcp-resource'),
      resource: {
        name: 'cee-fixture',
        transport: 'stdio',
        command: process.execPath,
        args: [fileURLToPath(new URL('./fixture-mcp.mjs', import.meta.url)), pidFile],
        envCredentialRefs: { CEE_FIXTURE_KEY: 'fixture-key' },
      },
    },
  ];
  const full = process.argv.includes('--full');
  const scenarios = full ? ['combined', 'deny', 'cancel', 'resume'] : ['combined'];
  let sessionId = randomUUID();
  let adapterSessionId;
  for (const scenario of scenarios) {
    if (scenario !== 'resume') {
      sessionId = randomUUID();
      adapterSessionId = undefined;
    }
    const adapter = new CodeBuddyAdapter({
      allowUnverifiedExtensions: true,
      extensionStateRoot: path.join(root, 'state'),
      runTimeoutMs: 60000,
      idleTimeoutMs: 30000,
      shutdownGraceMs: 3000,
      maxBudgetUsd: 0.05,
    });
    const runtime = await adapter.createRuntime({
      credentials: { CODEBUDDY_API_KEY: credential, 'fixture-key': canary },
      config: {
        internetEnvironment: process.env.CODEBUDDY_INTERNET_ENVIRONMENT ?? 'internal',
        ...(process.env.CODEBUDDY_BASE_URL ? { baseUrl: process.env.CODEBUDDY_BASE_URL } : {}),
      },
    });
    const runId = randomUUID();
    const input = {
      runId,
      sessionId,
      cwd,
      prompt:
        scenario === 'combined'
          ? 'Use the selected cee-fixture skill and follow its instructions exactly.'
          : scenario === 'cancel'
            ? 'Call the fixture_wait MCP tool now.'
            : scenario === 'deny'
              ? 'Call the fixture_read MCP tool now, and report denial if permission is rejected.'
              : 'Use the selected cee-fixture skill again.',
      permissionPolicy: 'interactive',
      configScopes: [],
      extensions: snapshots.map(({ extensionId, version }) => ({ extensionId, version, enabled: true })),
      extensionSnapshots: snapshots,
      maxTurns: 5,
      ...(scenario === 'resume' && adapterSessionId ? { adapterSessionId } : {}),
      ...(process.env.CODEBUDDY_MODEL
        ? { model: { adapterId: 'cn.tencent.codebuddy', modelId: process.env.CODEBUDDY_MODEL } }
        : {}),
    };
    const events = [];
    try {
      for await (const event of input.adapterSessionId ? runtime.resumeRun(input) : runtime.startRun(input)) {
        events.push(event);
        if (event.type === 'session.initialized') adapterSessionId = event.payload.adapterSessionId;
        if (event.type === 'interaction.requested') {
          const response =
            event.payload.kind === 'question'
              ? {
                  requestId: event.payload.requestId,
                  action: 'submit',
                  answers: Object.fromEntries(event.payload.questions.map(({ id }) => [id, 'yes'])),
                }
              : { requestId: event.payload.requestId, action: scenario === 'deny' ? 'deny' : 'allow' };
          await runtime.respondToInteraction(response);
        }
        if (scenario === 'cancel' && event.type === 'tool.started' && event.payload.name.includes('fixture_wait'))
          await runtime.cancel({ runId });
        if (events.length > 1000) {
          await runtime.cancel({ runId });
          throw new Error('EVENT_LIMIT');
        }
      }
    } finally {
      await runtime.dispose();
    }
    const serialized = JSON.stringify(events);
    const current = {
      scenario,
      eventTypes: events.map(({ type }) => type),
      terminal: events.at(-1)?.type,
      terminalCount: events.filter(({ type }) => ['run.completed', 'run.failed', 'run.cancelled'].includes(type))
        .length,
      skillTool: events.some((event) => event.type === 'tool.started' && event.payload.name === 'Skill'),
      mcpTool: events.some((event) => event.type === 'tool.started' && event.payload.name.includes('fixture_read')),
      mcpResult: events.some(
        (event) =>
          event.type === 'tool.completed' && JSON.stringify(event.payload.outputSummary).includes('CEE_MCP_OK'),
      ),
      skillResult: events.some(
        (event) => event.type === 'assistant.message' && event.payload.text.includes('CEE_SKILL_OK'),
      ),
      question: events.some((event) => event.type === 'interaction.requested' && event.payload.kind === 'question'),
      permissionDenied: events.some(
        (event) => event.type === 'interaction.resolved' && event.payload.outcome === 'denied',
      ),
      secretsAbsent: !serialized.includes(credential) && !serialized.includes(canary),
      pathsAbsent: !serialized.includes(root),
      projectionCleaned: !(await readdir(path.join(root, 'state', sessionId))).some(
        (name) => name.startsWith('run-') || name === '.extension-lease',
      ),
    };
    report.cases.push(current);
    if (scenario === 'combined') report.combinedSession = { sessionId, adapterSessionId };
    if (scenario === 'cancel' && report.combinedSession) {
      sessionId = report.combinedSession.sessionId;
      adapterSessionId = report.combinedSession.adapterSessionId;
    }
  }
  delete report.combinedSession;
  const pids = (await readFile(pidFile, 'utf8').catch(() => ''))
    .trim()
    .split('\n')
    .map(Number)
    .filter((pid) => pid > 0);
  const alive = pids.filter((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });
  report.fixtureProcessesCleaned = alive.length === 0;
  for (const pid of alive) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* The fixture already exited. */
    }
  }
  report.status =
    report.cases.every(
      (item) =>
        item.terminalCount === 1 &&
        item.secretsAbsent &&
        item.pathsAbsent &&
        item.projectionCleaned &&
        (item.scenario === 'combined' || item.scenario === 'resume'
          ? item.skillTool &&
            item.skillResult &&
            item.mcpTool &&
            item.mcpResult &&
            item.question &&
            item.terminal === 'run.completed'
          : item.scenario === 'deny'
            ? item.permissionDenied
            : item.terminal === 'run.cancelled'),
    ) && report.fixtureProcessesCleaned
      ? 'passed'
      : 'failed';
  report.fullMatrix = full;
  report.fullScenarioMatrixPassed = report.status === 'passed' && full;
} catch (error) {
  report.status = 'blocked';
  report.reason = [
    'OPT_IN_REQUIRED',
    'PRIVATE_CREDENTIAL_FILE_REQUIRED',
    'TEST_CREDENTIAL_REQUIRED',
    'EVENT_LIMIT',
  ].includes(error.message)
    ? error.message
    : 'PROBE_FAILED_REDACTED';
} finally {
  delete report.combinedSession;
  if (root) {
    // Also clean known fixture children if a failure interrupted the evidence loop.
    const pids = (await readFile(path.join(root, 'fixture-pids.txt'), 'utf8').catch(() => ''))
      .trim()
      .split('\n')
      .map(Number)
      .filter((pid) => pid > 0);
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* Already stopped. */
      }
    }
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
}
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
if (report.status !== 'passed') process.exitCode = 2;
