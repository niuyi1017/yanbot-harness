import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const apiKey = process.env.CODEBUDDY_API_KEY;
if (!apiKey) {
  console.error('Packaged CodeBuddy test skipped: missing CODEBUDDY_API_KEY.');
  process.exitCode = 2;
} else {
  await run(apiKey);
}

async function run(secret) {
  const repositoryRoot = path.resolve(import.meta.dirname, '..');
  const version = JSON.parse(
    await readFile(path.join(repositoryRoot, 'packages/contracts/package.json'), 'utf8'),
  ).version;
  const releaseRoot = path.join(repositoryRoot, 'release', version);
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'yanbot-harness-codebuddy-release-test-'));
  let runtime;
  try {
    const consumerRoot = path.join(temporaryRoot, 'consumer');
    const runtimeRoot = path.join(temporaryRoot, 'runtime');
    const workspace = path.join(temporaryRoot, 'workspace');
    const stateRoot = path.join(temporaryRoot, 'state');
    await Promise.all(
      [consumerRoot, runtimeRoot, workspace, stateRoot].map((directory) =>
        mkdir(directory, { recursive: true, mode: 0o700 }),
      ),
    );
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
    const descriptorPath = path.join(stateRoot, 'runtime.json');
    const child = spawn(runtimeLauncher, [], {
      env: {
        ...consumerEnvironment(),
        YANBOT_HARNESS_STATE_DIR: stateRoot,
        CODEBUDDY_API_KEY: secret,
        CODEBUDDY_INTERNET_ENVIRONMENT: 'internal',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    runtime = { child, descriptorPath, stdout: '', stderr: '', stopped: false };
    child.stdout.on('data', (chunk) => (runtime.stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (runtime.stderr += redact(String(chunk), secret)));
    await waitForFile(descriptorPath, child, () => runtime.stderr);

    const consumerScript = path.join(consumerRoot, 'codebuddy-consumer.mjs');
    await writeFile(consumerScript, sdkConsumerSource());
    const sdkResult = await runProcess(process.execPath, [consumerScript, descriptorPath, workspace], {
      cwd: consumerRoot,
      env: consumerEnvironment(),
      timeoutMs: 5 * 60 * 1_000,
    });
    const sdkSummary = JSON.parse(sdkResult.stdout);
    assert(sdkSummary.initial === 'run.completed', 'Packaged CodeBuddy SDK initial run failed.');
    assert(sdkSummary.resume === 'run.completed', 'Packaged CodeBuddy SDK resume failed.');
    assert(sdkSummary.cancel === 'run.cancelled', 'Packaged CodeBuddy SDK cancellation failed.');
    assert(sdkSummary.models === 'unsupported', 'Packaged CodeBuddy capability downgrade mismatch.');

    const cli = path.join(consumerRoot, 'node_modules/@yanbot-harness/cli/dist/main.js');
    const cliResult = await runProcess(
      process.execPath,
      [
        cli,
        'run',
        'Reply with exactly: yanbot-harness-packaged-cli',
        '--descriptor',
        descriptorPath,
        '--json',
        '--permission',
        'read-only',
        '--log-level',
        'silent',
      ],
      { cwd: workspace, env: consumerEnvironment(), timeoutMs: 5 * 60 * 1_000 },
    );
    assert(jsonLines(cliResult.stdout).at(-1)?.type === 'run.completed', 'Packaged CodeBuddy CLI run failed.');

    await new Promise((resolve) => globalThis.setTimeout(resolve, 250));
    const childCheck = await runProcess('pgrep', ['-P', String(child.pid)], {
      acceptedExitCodes: [0, 1],
      env: consumerEnvironment(),
    });
    assert(childCheck.stdout.trim() === '', 'CodeBuddy child process remained beneath the packaged Runtime.');

    await stopRuntime(runtime);
    process.stdout.write(
      `${JSON.stringify({ ok: true, version, sdk: ['initial', 'resume', 'cancel'], cli: ['jsonl'], childProcesses: 0 })}\n`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(redact(message, secret));
    process.exitCode = 1;
  } finally {
    if (runtime && !runtime.stopped) await stopRuntime(runtime).catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
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

async function runProcess(command, arguments_, options = {}) {
  const child = spawn(command, arguments_, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += String(chunk)));
  child.stderr.on('data', (chunk) => (stderr += String(chunk)));
  const result = await waitForExit(child, options.timeoutMs ?? 30_000);
  const accepted = options.acceptedExitCodes ?? [0];
  if (!accepted.includes(result.code))
    throw new Error(`${path.basename(command)} exited ${result.code}: ${stderr.trim()}`);
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

function redact(value, secret) {
  return secret ? value.split(secret).join('[REDACTED]') : value;
}

function sdkConsumerSource() {
  return `
import { HarnessClient, HarnessSdkError } from '@yanbot-harness/sdk';

const [descriptorPath, workspace] = process.argv.slice(2);
if (process.env.CODEBUDDY_API_KEY) throw new Error('Vendor key reached the SDK consumer process.');
const client = await HarnessClient.fromDaemon({ descriptorPath });
const adapter = (await client.listAdapters()).find((item) => item.manifest.adapterId === 'cn.tencent.codebuddy');
if (!adapter) throw new Error('CodeBuddy Adapter unavailable.');
let models = 'unexpected';
try {
  await client.listModels(adapter.manifest.adapterId);
} catch (error) {
  if (error instanceof HarnessSdkError && error.harnessError?.code === 'CAPABILITY_UNSUPPORTED') models = 'unsupported';
  else throw error;
}
const grant = await client.grantWorkspace({ path: workspace });
const session = await client.createSession({ adapterId: adapter.manifest.adapterId });

async function execute(prompt, resume) {
  const run = await client.createRun(session.sessionId, {
    prompt,
    workspaceGrant: grant.grant,
    permissionPolicy: 'read-only',
    configScopes: [],
    extensions: [],
    resume,
  });
  let terminal;
  for await (const event of run.events()) {
    if (event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.cancelled') terminal = event.type;
  }
  return terminal;
}

const initial = await execute('Reply with exactly: yanbot-harness-packaged-sdk', false);
const resume = await execute('Reply with exactly: yanbot-harness-packaged-resume', true);
const cancelSession = await client.createSession({ adapterId: adapter.manifest.adapterId });
const cancelRun = await client.createRun(cancelSession.sessionId, {
  prompt: 'Wait briefly, then reply with: yanbot-harness-packaged-cancel',
  workspaceGrant: grant.grant,
  permissionPolicy: 'read-only',
  configScopes: [],
  extensions: [],
  resume: false,
});
let cancel;
for await (const event of cancelRun.events()) {
  if (event.type === 'run.started') await cancelRun.cancel('Packaged CodeBuddy cancellation.');
  if (event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.cancelled') cancel = event.type;
}
console.log(JSON.stringify({ initial, resume, cancel, models }));
`;
}
