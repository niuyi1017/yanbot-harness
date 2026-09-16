import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { npmInvocation } from './lib/release-platform.mjs';

// Read-only input archives; all installs and business state belong to this fresh probe.
assert(process.platform === 'darwin' && process.arch === 'arm64');
const [oldArgument, commonArgument, platformArgument] = process.argv.slice(2);
assert(
  oldArgument && commonArgument && platformArgument,
  'Use FROZEN_PREVIEW_2_ZIP COMMON_DIRECTORY VM_PLATFORM_DIRECTORY.',
);
const execute = promisify(execFile);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const oldZip = path.resolve(oldArgument);
const expectedOldSha = '109ae675089927f7244ce4a0754b5604414e937cd213e48e0f857e5cc4e8c1b0';
assert.equal(digest(await readFile(oldZip)), expectedOldSha, 'Refuse any other archive, including rebuilt preview.2.');
const commonRoot = path.resolve(commonArgument);
const platformRoot = path.resolve(platformArgument);
const common = JSON.parse(await readFile(path.join(commonRoot, 'common-manifest.json'), 'utf8'));
const platform = JSON.parse(await readFile(path.join(platformRoot, 'build-report.json'), 'utf8'));
assert.equal(platform.status, 'passed');
assert(platform.testSigning);
assert.equal(common.sourceCommit, platform.sourceCommit);
assert.equal(common.sourceLockSha256, platform.sourceLockSha256);
assert.equal(common.version, '0.1.0-preview.3');
assert.equal(platform.manifest.containment?.kind, 'macos-vm-v1');
const root = await mkdtemp(path.join(tmpdir(), 'harness-vm-rollback-'));
const environment = Object.fromEntries(
  ['PATH', 'HOME', 'TMPDIR'].flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : [])),
);
const report = {
  status: 'running',
  productionCertified: false,
  scope: 'Frozen preview.2 and test-signed VM development candidate; Reference only.',
  oldZipSha256: expectedOldSha,
  candidate: { sourceCommit: common.sourceCommit, version: common.version, artifact: platform.artifact },
  phases: [],
};
try {
  const snapshot = path.join(root, 'frozen.zip');
  await copyFile(oldZip, snapshot);
  assert.equal(digest(await readFile(snapshot)), expectedOldSha);
  await execute('/usr/bin/unzip', ['-q', snapshot, '-d', root], { timeout: 30000 });
  const frozen = path.join(root, 'yanbot-harness-0.1.0-preview.2-darwin-arm64');
  const oldManifest = JSON.parse(await readFile(path.join(frozen, 'manifest.json'), 'utf8'));
  assert.equal(oldManifest.version, '0.1.0-preview.2');
  assert.equal(oldManifest.gitDirty, false);
  report.oldSourceCommit = oldManifest.gitCommit;
  for (const artifact of oldManifest.artifacts) {
    assert(/^(?:packages|runtime)\/[A-Za-z0-9._-]+$/u.test(artifact.path));
    const bytes = await readFile(path.join(frozen, artifact.path));
    assert.equal(bytes.length, artifact.size);
    assert.equal(digest(bytes), artifact.sha256);
  }
  const runtimeArchive = oldManifest.artifacts.find((artifact) => artifact.path.startsWith('runtime/'));
  const runtimeDirectory = path.join(root, 'old-runtime');
  await mkdir(runtimeDirectory);
  await execute('/usr/bin/tar', ['-xzf', path.join(frozen, runtimeArchive.path), '-C', runtimeDirectory], {
    timeout: 30000,
  });
  const executablePath = path.join(
    runtimeDirectory,
    'yanbot-harness-runtime-0.1.0-preview.2-darwin-arm64/bin/yanbot-harness-runtime',
  );
  const oldConsumer = path.join(root, 'old-consumer');
  await mkdir(oldConsumer, { mode: 0o700 });
  await writeFile(path.join(oldConsumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  await writeFile(path.join(oldConsumer, 'user.npmrc'), '');
  await writeFile(path.join(oldConsumer, 'global.npmrc'), '');
  const npm = npmInvocation([
    'install',
    '--offline',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--save-exact',
    ...oldManifest.artifacts
      .filter((artifact) => artifact.path.startsWith('packages/'))
      .map((artifact) => path.join(frozen, artifact.path)),
  ]);
  await execute(npm.command, npm.arguments, {
    cwd: oldConsumer,
    timeout: 120000,
    maxBuffer: 8192,
    env: {
      ...environment,
      npm_config_cache: path.join(root, 'empty-npm-cache'),
      npm_config_registry: 'http://127.0.0.1:9',
      npm_config_userconfig: path.join(oldConsumer, 'user.npmrc'),
      npm_config_globalconfig: path.join(oldConsumer, 'global.npmrc'),
      npm_config_update_notifier: 'false',
    },
  });
  const kit = JSON.parse(
    (
      await execute(
        process.execPath,
        [path.join(import.meta.dirname, 'build-offline-kit.mjs'), '--common', commonRoot, '--platform', platformRoot],
        { timeout: 60000, maxBuffer: 8192 },
      )
    ).stdout,
  );
  const newConsumer = path.join(root, 'new-consumer');
  const installation = JSON.parse(
    (
      await execute(
        process.execPath,
        [
          path.join(kit.directory, 'install-local.mjs'),
          '--prefix',
          newConsumer,
          '--trusted-key-file',
          kit.externalTestTrust,
        ],
        { env: environment, timeout: 180000, maxBuffer: 8192 },
      )
    ).stdout,
  );
  assert.equal(installation.reference.terminal, 'run.completed');
  report.candidateInstallation = installation;
  const stateRoot = path.join(root, 'persistent-state');
  const workspace = path.join(root, '工作区 space');
  await mkdir(stateRoot, { mode: 0o700 });
  await mkdir(workspace, { mode: 0o700 });
  await writeFile(path.join(workspace, 'sentinel.txt'), 'preserve-user-content');
  const records = path.join(root, 'business-records.json');
  await writeFile(records, '[]');
  for (const phase of ['old-before-upgrade', 'vm-candidate', 'old-after-rollback']) {
    const vm = phase === 'vm-candidate';
    const directory = vm ? newConsumer : oldConsumer;
    const options = vm
      ? {
          stateRoot,
          reference: true,
          requireContainment: true,
          startupTimeoutMs: 120000,
          shutdownTimeoutMs: 15000,
          vm: { workspaces: [{ path: workspace, readOnly: true }] },
        }
      : {
          stateRoot: path.join(stateRoot, 'guest-state'),
          reference: true,
          executablePath,
          startupTimeoutMs: 30000,
          shutdownTimeoutMs: 15000,
        };
    const probe = path.join(directory, 'business-rollback.mjs');
    await writeFile(
      probe,
      `
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { startManagedRuntime } from '${vm ? '@yanbot-harness/local' : '@yanbot-harness/sdk'}';
const options = ${JSON.stringify(options)};
${vm ? `options.trustedKeys = JSON.parse(await readFile(${JSON.stringify(kit.externalTestTrust)}, 'utf8'));` : ''}
const rows = JSON.parse(await readFile(${JSON.stringify(records)}, 'utf8'));
const runtime = await startManagedRuntime(options);
try {
  assert.equal((await runtime.client.health()).status, 'ok');
  for (const row of rows) {
    assert.deepEqual(await runtime.client.getSession(row.session.sessionId), row.session);
    assert.deepEqual(await runtime.client.getRun(row.run.runId), row.run);
    const replay = [];
    for await (const event of runtime.client.events(row.run.runId, {signal: AbortSignal.timeout(15000)})) replay.push(event);
    assert.deepEqual(replay, row.events);
  }
  assert.equal((await runtime.client.listSessions()).length, rows.length);
  const grant = await runtime.client.grantWorkspace({path: ${JSON.stringify(workspace)}});
  const session = await runtime.client.createSession({adapterId: 'cn.yanbot.reference'});
  const run = await runtime.client.createRun(session.sessionId, {prompt: ${JSON.stringify(phase)}, workspaceGrant: grant.grant,
    permissionPolicy: 'read-only', configScopes: [], extensions: [], resume: false});
  const events = [];
  for await (const event of run.events({signal: AbortSignal.timeout(15000)})) events.push(event);
  assert.equal(events.at(-1).type, 'run.completed');
  rows.push({session: await runtime.client.getSession(session.sessionId), run: await run.refresh(), events});
  await writeFile(${JSON.stringify(records)}, JSON.stringify(rows));
} finally { await runtime.close(); }
console.log(JSON.stringify({phase: ${JSON.stringify(phase)}, status: 'passed', preservedSessions: rows.length - 1,
  createdSessions: 1, completeRunAndEventReplay: true}));
`,
    );
    const result = JSON.parse(
      (
        await execute(process.execPath, [probe], {
          cwd: directory,
          env: environment,
          timeout: 150000,
          maxBuffer: 8192,
        })
      ).stdout,
    );
    if (vm) assert.equal(await readFile(path.join(stateRoot, 'vm-lease'), 'utf8'), 'stopped\n');
    assert.equal(await readFile(path.join(workspace, 'sentinel.txt'), 'utf8'), 'preserve-user-content');
    report.phases.push(result);
  }
  assert.equal(digest(await readFile(oldZip)), expectedOldSha);
  assert.equal(digest(await readFile(path.join(platformRoot, platform.artifact.file))), platform.artifact.sha256);
  report.inputArtifactsUnchanged = true;
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = error.message;
  process.exitCode = 1;
} finally {
  await writeFile(path.join(root, 'rollback-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(
    JSON.stringify({ status: report.status, directory: root, phases: report.phases.length, error: report.error }),
  );
}
