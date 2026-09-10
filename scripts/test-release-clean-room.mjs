import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const version = JSON.parse(
  await readFile(path.join(repositoryRoot, 'packages/contracts/package.json'), 'utf8'),
).version;
const releaseRoot = path.join(repositoryRoot, 'release', version);
const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'yanbot-harness-release-test-'));
const consumerRoot = path.join(temporaryRoot, 'consumer');
const runtimeRoot = path.join(temporaryRoot, 'runtime');
const activeRuntimes = [];

try {
  await mkdir(consumerRoot, { recursive: true, mode: 0o700 });
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  await writeFile(path.join(consumerRoot, 'package.json'), '{"private":true,"type":"module"}\n');
  const packageArchives = (await readdir(path.join(releaseRoot, 'packages')))
    .filter((name) => name.endsWith('.tgz'))
    .map((name) => path.join(releaseRoot, 'packages', name));
  await runProcess(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', ...packageArchives],
    { cwd: consumerRoot, env: consumerEnvironment() },
  );

  const runtimeArchive = (await readdir(path.join(releaseRoot, 'runtime'))).find((name) => name.endsWith('.tar.gz'));
  assert(runtimeArchive, 'Runtime archive is missing.');
  await runProcess('tar', ['-xzf', path.join(releaseRoot, 'runtime', runtimeArchive), '-C', runtimeRoot]);
  const bundleDirectory = path.join(runtimeRoot, (await readdir(runtimeRoot))[0]);
  const runtimeLauncher = path.join(bundleDirectory, 'bin', 'yanbot-harness-runtime');
  const cli = path.join(consumerRoot, 'node_modules/@yanbot-harness/cli/dist/main.js');
  const workspace = path.join(temporaryRoot, 'workspace');
  await mkdir(workspace, { mode: 0o700 });

  const runtimeVersion = await runProcess(runtimeLauncher, ['--version'], { env: consumerEnvironment() });
  assert(runtimeVersion.stdout.trim() === version, 'Runtime --version mismatch.');
  const cliVersion = await runProcess(process.execPath, [cli, '--version'], { env: consumerEnvironment() });
  assert(cliVersion.stdout.trim() === version, 'CLI --version mismatch.');
  const cliHelp = await runProcess(process.execPath, [cli, '--help'], { env: consumerEnvironment() });
  assert(cliHelp.stdout.includes('yanbot-harness run'), 'CLI --help is incomplete.');

  const sdkScript = path.join(consumerRoot, 'sdk-consumer.mjs');
  await writeFile(sdkScript, sdkConsumerSource());
  const managedSdkScript = path.join(consumerRoot, 'managed-sdk-consumer.mjs');
  await writeFile(managedSdkScript, managedSdkConsumerSource());

  const managedSdk = await runProcess(process.execPath, [managedSdkScript, runtimeLauncher, workspace], {
    cwd: consumerRoot,
    env: {
      ...consumerEnvironment(),
      YANBOT_HARNESS_ADAPTER: 'reference',
      YANBOT_HARNESS_REFERENCE_SCENARIO: 'text',
    },
  });
  const managedSdkSummary = JSON.parse(managedSdk.stdout);
  assert(managedSdkSummary.terminal === 'run.completed', 'Packaged managed SDK run did not complete.');
  assert(managedSdkSummary.cleaned === true, 'Packaged managed SDK did not clean its temporary state.');

  const managedCliTemp = path.join(temporaryRoot, 'managed-cli-temp');
  await mkdir(managedCliTemp, { mode: 0o700 });
  const managedCli = await runProcess(
    process.execPath,
    [cli, 'run', 'clean room managed CLI', '--managed-runtime', runtimeLauncher, '--json', '--log-level', 'silent'],
    {
      cwd: workspace,
      env: {
        ...consumerEnvironment(),
        TMPDIR: managedCliTemp,
        YANBOT_HARNESS_ADAPTER: 'reference',
        YANBOT_HARNESS_REFERENCE_SCENARIO: 'text',
      },
    },
  );
  assert(jsonLines(managedCli.stdout).at(-1)?.type === 'run.completed', 'Packaged managed CLI did not complete.');
  assert((await readdir(managedCliTemp)).length === 0, 'Packaged managed CLI left temporary state behind.');

  const textRuntime = await startRuntime('text', runtimeLauncher);
  const textSdk = await runProcess(process.execPath, [sdkScript, 'text', textRuntime.descriptorPath, workspace], {
    cwd: consumerRoot,
    env: consumerEnvironment(),
  });
  const textSummary = JSON.parse(textSdk.stdout);
  assert(textSummary.terminal === 'run.completed', 'Packaged SDK text run did not complete.');
  assert(textSummary.models === 1, 'Packaged SDK model listing failed for Reference Adapter.');

  const cliText = await runProcess(
    process.execPath,
    [cli, 'run', 'clean room text', '--descriptor', textRuntime.descriptorPath, '--log-level', 'silent'],
    { cwd: workspace, env: consumerEnvironment() },
  );
  assert(cliText.stdout === 'Reference response.\n', 'Packaged CLI text output mismatch.');
  const cliJson = await runProcess(
    process.execPath,
    [cli, 'run', 'clean room json', '--descriptor', textRuntime.descriptorPath, '--json', '--log-level', 'silent'],
    { cwd: workspace, env: consumerEnvironment() },
  );
  const jsonRecords = jsonLines(cliJson.stdout);
  assert(jsonRecords.at(-1)?.type === 'run.completed', 'Packaged CLI JSONL run did not complete.');
  const sessionId = jsonRecords[0]?.run?.sessionId;
  assert(typeof sessionId === 'string', 'Packaged CLI did not return a Session ID.');
  const resumed = await runProcess(
    process.execPath,
    [
      cli,
      'run',
      'clean room resume',
      '--descriptor',
      textRuntime.descriptorPath,
      '--session',
      sessionId,
      '--resume',
      '--json',
      '--log-level',
      'silent',
    ],
    { cwd: workspace, env: consumerEnvironment() },
  );
  assert(jsonLines(resumed.stdout).at(-1)?.type === 'run.completed', 'Packaged CLI resume did not complete.');
  await stopRuntime(textRuntime);

  const permissionRuntime = await startRuntime('permission', runtimeLauncher);
  const permissionSdk = await runProcess(
    process.execPath,
    [sdkScript, 'permission', permissionRuntime.descriptorPath, workspace],
    { cwd: consumerRoot, env: consumerEnvironment() },
  );
  const permissionSummary = JSON.parse(permissionSdk.stdout);
  assert(permissionSummary.interaction === true, 'Packaged SDK did not receive the Reference interaction.');
  assert(permissionSummary.terminal === 'run.completed', 'Packaged SDK interaction did not complete.');
  await stopRuntime(permissionRuntime);

  const cancelRuntime = await startRuntime('wait-for-cancel', runtimeLauncher);
  const cancelledSdk = await runProcess(
    process.execPath,
    [sdkScript, 'cancel', cancelRuntime.descriptorPath, workspace],
    {
      cwd: consumerRoot,
      env: consumerEnvironment(),
    },
  );
  assert(JSON.parse(cancelledSdk.stdout).terminal === 'run.cancelled', 'Packaged SDK cancellation failed.');

  const cliRun = startStreamingProcess(
    process.execPath,
    [cli, 'run', 'clean room cancel', '--descriptor', cancelRuntime.descriptorPath, '--json', '--log-level', 'silent'],
    { cwd: workspace, env: consumerEnvironment() },
  );
  const created = JSON.parse(await cliRun.firstLine);
  assert(created.type === 'cli.run-created' && created.run?.runId, 'Packaged CLI did not create a cancellable run.');
  await runProcess(
    process.execPath,
    [cli, 'cancel', created.run.runId, '--descriptor', cancelRuntime.descriptorPath, '--json', '--log-level', 'silent'],
    { cwd: workspace, env: consumerEnvironment() },
  );
  const cliCancelled = await cliRun.completed;
  assert(cliCancelled.code === 10, 'Packaged CLI cancellation exit code mismatch.');
  assert(jsonLines(cliCancelled.stdout).at(-1)?.type === 'run.cancelled', 'Packaged CLI cancellation event missing.');
  await stopRuntime(cancelRuntime);

  process.stdout.write(
    `${JSON.stringify({ ok: true, version, sdk: ['managed', 'text', 'interaction', 'cancel'], cli: ['managed', 'text', 'jsonl', 'resume', 'cancel'] })}\n`,
  );
} finally {
  await Promise.allSettled(activeRuntimes.map((runtime) => stopRuntime(runtime)));
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function startRuntime(scenario, launcher) {
  const stateRoot = path.join(temporaryRoot, `state-${scenario}-${Date.now()}`);
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const child = spawn(launcher, ['--reference'], {
    env: { ...consumerEnvironment(), YANBOT_HARNESS_STATE_DIR: stateRoot, YANBOT_HARNESS_REFERENCE_SCENARIO: scenario },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const runtime = {
    child,
    descriptorPath: path.join(stateRoot, 'runtime.json'),
    stdout: '',
    stderr: '',
    stopped: false,
  };
  activeRuntimes.push(runtime);
  child.stdout.on('data', (chunk) => (runtime.stdout += String(chunk)));
  child.stderr.on('data', (chunk) => (runtime.stderr += String(chunk)));
  await waitForFile(runtime.descriptorPath, child, () => runtime.stderr);
  const descriptorInfo = await stat(runtime.descriptorPath);
  if (process.platform !== 'win32') assert((descriptorInfo.mode & 0o077) === 0, 'Runtime descriptor is not mode 0600.');
  return runtime;
}

async function stopRuntime(runtime) {
  if (runtime.stopped) return;
  runtime.stopped = true;
  runtime.child.kill('SIGTERM');
  const result = await waitForExit(runtime.child, 10_000);
  assert(result.code === 0, `Runtime shutdown failed: ${runtime.stderr.trim()}`);
  try {
    await stat(runtime.descriptorPath);
    throw new Error('Runtime descriptor remained after shutdown.');
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

function startStreamingProcess(command, arguments_, options) {
  const child = spawn(command, arguments_, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let firstLineResolved = false;
  let resolveFirstLine;
  let rejectFirstLine;
  const firstLine = new Promise((resolve, reject) => {
    resolveFirstLine = resolve;
    rejectFirstLine = reject;
  });
  const timer = globalThis.setTimeout(
    () => rejectFirstLine(new Error('Timed out waiting for CLI run creation.')),
    10_000,
  );
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk);
    if (!firstLineResolved && stdout.includes('\n')) {
      firstLineResolved = true;
      globalThis.clearTimeout(timer);
      resolveFirstLine(stdout.slice(0, stdout.indexOf('\n')));
    }
  });
  child.stderr.on('data', (chunk) => (stderr += String(chunk)));
  const completed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  completed.then((result) => {
    if (!firstLineResolved) rejectFirstLine(new Error(`CLI exited before creating a run: ${result.stderr}`));
  });
  return { firstLine, completed };
}

async function runProcess(command, arguments_, options = {}) {
  const child = spawn(command, arguments_, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += String(chunk)));
  child.stderr.on('data', (chunk) => (stderr += String(chunk)));
  const result = await waitForExit(child, 30_000);
  if (result.code !== 0) throw new Error(`${path.basename(command)} exited ${result.code}: ${stderr.trim()}`);
  return { ...result, stdout, stderr };
}

async function waitForExit(child, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal }));
      }),
      new Promise((_, reject) => {
        timer = globalThis.setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`Process ${child.pid ?? 'unknown'} exceeded ${timeoutMs}ms.`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) globalThis.clearTimeout(timer);
  }
}

async function waitForFile(file, child, stderr) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await stat(file);
      return;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    if (child.exitCode !== null) throw new Error(`Runtime exited before descriptor creation: ${stderr().trim()}`);
    await new Promise((resolve) => globalThis.setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for the Runtime descriptor.');
}

function consumerEnvironment() {
  return Object.fromEntries(
    ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot'].flatMap((key) =>
      process.env[key] === undefined ? [] : [[key, process.env[key]]],
    ),
  );
}

function jsonLines(value) {
  return value
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isMissing(error) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function sdkConsumerSource() {
  return `
import { HarnessClient } from '@yanbot-harness/sdk';

const [mode, descriptorPath, workspace] = process.argv.slice(2);
const client = await HarnessClient.fromDaemon({ descriptorPath });
await client.health();
const adapters = await client.listAdapters();
const adapterId = adapters[0]?.manifest.adapterId;
if (!adapterId) throw new Error('No Adapter.');
const models = await client.listModels(adapterId);
const grant = await client.grantWorkspace({ path: workspace });
const session = await client.createSession({ adapterId });
const run = await client.createRun(session.sessionId, {
  prompt: 'Packaged SDK clean-room test',
  workspaceGrant: grant.grant,
  permissionPolicy: 'interactive',
  configScopes: [],
  extensions: [],
  resume: false,
});
let interaction = false;
let terminal;
for await (const event of run.events()) {
  if (mode === 'cancel' && event.type === 'run.started') await run.cancel('Clean-room cancellation.');
  if (event.type === 'interaction.requested') {
    interaction = true;
    await run.respond({ requestId: event.payload.requestId, action: 'allow' });
  }
  if (event.type === 'run.completed' || event.type === 'run.cancelled' || event.type === 'run.failed') terminal = event.type;
}
console.log(JSON.stringify({ terminal, interaction, models: models.length }));
`;
}

function managedSdkConsumerSource() {
  return `
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { startManagedRuntime } from '@yanbot-harness/sdk';

const [runtimePath, workspace] = process.argv.slice(2);
const runtime = await startManagedRuntime({
  executablePath: runtimePath,
  environment: process.env,
  startupTimeoutMs: 10_000,
  shutdownTimeoutMs: 10_000,
});
let terminal;
try {
  const adapters = await runtime.client.listAdapters();
  const adapterId = adapters[0]?.manifest.adapterId;
  if (!adapterId) throw new Error('No Adapter.');
  const grant = await runtime.client.grantWorkspace({ path: workspace });
  const session = await runtime.client.createSession({ adapterId });
  const run = await runtime.client.createRun(session.sessionId, {
    prompt: 'Packaged managed SDK clean-room test',
    workspaceGrant: grant.grant,
    permissionPolicy: 'read-only',
    configScopes: [],
    extensions: [],
    resume: false,
  });
  for await (const event of run.events()) {
    if (event.type === 'run.completed' || event.type === 'run.cancelled' || event.type === 'run.failed') {
      terminal = event.type;
    }
  }
} finally {
  await runtime.close();
}
let cleaned = false;
try {
  await stat(path.dirname(runtime.descriptorPath));
} catch (error) {
  cleaned = error && typeof error === 'object' && error.code === 'ENOENT';
}
console.log(JSON.stringify({ terminal, cleaned }));
`;
}
