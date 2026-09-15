import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { createGunzip } from 'node:zlib';
import { Buffer } from 'node:buffer';
import tar from 'tar-stream';

import { npmInvocation } from './lib/release-platform.mjs';

const execute = promisify(execFile);
const args = process.argv.slice(2).filter((arg) => arg !== '--');
assert(
  args.length === 4 && args[0] === '--common' && args[2] === '--platform',
  'Use --common COMMON_DIRECTORY --platform PLATFORM_BUILD_DIRECTORY.',
);
const commonRoot = path.resolve(args[1]);
const platformRoot = path.resolve(args[3]);
const common = JSON.parse(await readFile(path.join(commonRoot, 'common-manifest.json'), 'utf8'));
const platform = JSON.parse(await readFile(path.join(platformRoot, 'build-report.json'), 'utf8'));
assert.equal(platform.status, 'passed');
assert(platform.testSigning, 'This test only accepts ephemeral signed fixtures.');
assert.equal(common.version, platform.version);
assert.equal(common.sourceCommit, platform.sourceCommit);
assert.equal(common.sourceLockSha256, platform.sourceLockSha256);
const root = await mkdtemp(path.join(tmpdir(), 'harness-installed-matrix-'));
const target = process.platform + '-' + process.arch;
const trustedKeys = JSON.parse(await readFile(path.join(platformRoot, 'test-trust.json'), 'utf8'));
const artifacts = [
  ...common.artifacts.map((item) => ({ ...item, source: path.join(commonRoot, 'packages', item.file) })),
  {
    name: platform.manifest.packageName,
    version: platform.version,
    ...platform.artifact,
    source: path.join(platformRoot, platform.artifact.file),
  },
];
const packages = new Map();
const requests = [];
const cases = [];
let denied;
let registry;
for (const artifact of artifacts) {
  const bytes = await readFile(artifact.source);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256);
  assert.equal(bytes.length, artifact.size);
  const extractor = tar.extract();
  const running = pipeline(createReadStream(artifact.source), createGunzip(), extractor);
  running.catch(() => undefined);
  let manifest;
  for await (const stream of extractor) {
    if (stream.header.name === 'package/package.json') {
      const chunks = [];
      let size = 0;
      for await (const chunk of stream) {
        size += chunk.length;
        assert(size <= 65536);
        chunks.push(chunk);
      }
      manifest = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } else for await (const chunk of stream) void chunk;
  }
  await running;
  assert.equal(manifest?.name, artifact.name);
  assert.equal(manifest.version, artifact.version);
  if (manifest.name === '@yanbot-harness/runtime')
    assert.deepEqual(
      manifest.optionalDependencies,
      Object.fromEntries(
        ['darwin-arm64', 'win32-x64', 'linux-x64'].map((t) => ['@yanbot-harness/runtime-' + t, common.version]),
      ),
    );
  packages.set(artifact.name, {
    ...artifact,
    manifest,
    integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'),
  });
}
const server = createServer((request, response) => {
  const name = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname.slice(1));
  requests.push(name); // Never retain request headers/tokens.
  const artifact = [...packages.values()].find((item) => name === 'tarballs/' + item.file);
  const item = packages.get(name);
  if (denied && (item?.name ?? artifact?.name) === denied) {
    response.writeHead(401);
    response.end('{}');
    return;
  }
  if (artifact) {
    createReadStream(artifact.source).pipe(response);
    return;
  }
  if (!item) {
    response.writeHead(404);
    response.end('{}');
    return;
  }
  response.setHeader('content-type', 'application/json');
  response.end(
    JSON.stringify({
      name: item.name,
      'dist-tags': { latest: item.version },
      time: {
        created: '2020-01-01T00:00:00Z',
        modified: '2020-01-01T00:00:00Z',
        [item.version]: '2020-01-01T00:00:00Z',
      },
      versions: {
        [item.version]: {
          ...item.manifest,
          dist: { tarball: registry + '/tarballs/' + item.file, integrity: item.integrity },
        },
      },
    }),
  );
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
registry = 'http://127.0.0.1:' + server.address().port;
const environment = Object.fromEntries(
  [
    'PATH',
    'Path',
    'SystemRoot',
    'SYSTEMROOT',
    'WINDIR',
    'HOME',
    'USERPROFILE',
    'LOCALAPPDATA',
    'APPDATA',
    'TEMP',
    'TMP',
    'TMPDIR',
  ].flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : [])),
);

async function consumer(label) {
  const directory = path.join(root, label);
  await mkdir(directory, { mode: 0o700 });
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  await writeFile(path.join(directory, 'user.npmrc'), '');
  await writeFile(path.join(directory, 'global.npmrc'), '');
  return directory;
}
async function install(manager, directory, name, extra = []) {
  const argv = ['install', '--ignore-scripts', '--registry', registry, ...extra, name + '@' + common.version];
  const command =
    manager === 'npm'
      ? npmInvocation([...argv, '--no-audit', '--no-fund'])
      : {
          command: process.execPath,
          arguments: [process.env.npm_execpath, ...argv, '--store-dir', path.join(directory, 'store')],
        };
  return execute(command.command, command.arguments, {
    cwd: directory,
    timeout: 120000,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
    env: {
      ...environment,
      CI: 'true',
      npm_config_registry: registry,
      npm_config_userconfig: path.join(directory, 'user.npmrc'),
      npm_config_globalconfig: path.join(directory, 'global.npmrc'),
      npm_config_cache: path.join(directory, 'npm-cache'),
      npm_config_update_notifier: 'false',
    },
  });
}
async function run(directory, source) {
  const file = path.join(directory, 'consumer-test.mjs');
  await writeFile(file, source);
  return execute(process.execPath, [file], {
    cwd: directory,
    env: environment,
    timeout: 150000,
    windowsHide: true,
    maxBuffer: 8192,
  });
}
const localSmoke = `import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { startManagedRuntime, HARNESS_RELEASE_VERSION } from '@yanbot-harness/local';
assert.equal(HARNESS_RELEASE_VERSION, ${JSON.stringify(common.version)});
const runtimeEntry = import.meta.resolve('@yanbot-harness/local');
const trustedKeys = ${JSON.stringify(trustedKeys)};
const workspace = path.join(import.meta.dirname, 'workspace'); await mkdir(workspace);
for (const scenario of ['text', 'question', 'permission', 'wait-for-cancel']) {
  process.env.YANBOT_HARNESS_REFERENCE_SCENARIO = scenario;
  const handle = await startManagedRuntime({ reference: true, trustedKeys, cacheRoot: path.join(import.meta.dirname, 'cache'), startupTimeoutMs: 120000 });
  try {
    const grant = await handle.client.grantWorkspace({ path: workspace });
    const session = await handle.client.createSession({ adapterId: 'cn.yanbot.reference' });
    const run = await handle.client.createRun(session.sessionId, { prompt: 'Installed local matrix', workspaceGrant: grant.grant,
      permissionPolicy: 'interactive', configScopes: [], extensions: [], resume: false });
    let terminal;
    for await (const event of run.events({ signal: AbortSignal.timeout(15000) })) {
      if (scenario === 'wait-for-cancel' && event.type === 'run.started') await run.cancel('fixture cancellation');
      if (event.type === 'interaction.requested') {
        if (event.payload.kind === 'question') await run.respond({ requestId: event.payload.requestId, action: 'submit', answers: { [event.payload.questions[0].id]: 'yes' } });
        else await run.respond({ requestId: event.payload.requestId, action: 'allow' });
      }
      terminal = event.type;
    }
    assert.equal(terminal, scenario === 'wait-for-cancel' ? 'run.cancelled' : 'run.completed');
  } finally { await handle.close(); }
}
console.log(JSON.stringify({ status: 'passed', runtimeEntry, scenarios: 4 }));
`;
const report = {
  schemaVersion: 1,
  kind: 'real-unified-package-installation',
  target,
  version: common.version,
  sourceCommit: common.sourceCommit,
  sourceLockSha256: common.sourceLockSha256,
  testSigning: true,
  cases,
};
try {
  for (const manager of ['npm', 'pnpm']) {
    const directory = await consumer(manager + '-local');
    const start = requests.length;
    await install(manager, directory, '@yanbot-harness/local');
    const result = JSON.parse((await run(directory, localSmoke)).stdout);
    if (manager === 'pnpm') assert(result.runtimeEntry.includes('/.pnpm/'));
    assert(requests.slice(start).some((name) => name === 'tarballs/' + platform.artifact.file));
    cases.push({
      name: manager + '-local-reference-interactions-cancel',
      status: 'passed',
      scenarios: result.scenarios,
    });
    const slim = await consumer(manager + '-sdk-only');
    const index = requests.length;
    await install(manager, slim, '@yanbot-harness/sdk');
    await run(
      slim,
      "import assert from 'node:assert/strict'; import { HarnessClient } from '@yanbot-harness/sdk'; assert(HarnessClient); let missing = false; try { import.meta.resolve('@yanbot-harness/runtime'); } catch { missing = true; } assert(missing);",
    );
    assert(!requests.slice(index).some((name) => /runtime|adapter|core/u.test(name)));
    cases.push({ name: manager + '-sdk-only-no-runtime-download', status: 'passed' });
  }
  const missing = await consumer('npm-no-optional');
  await install('npm', missing, '@yanbot-harness/local', ['--omit=optional']);
  await run(
    missing,
    "import assert from 'node:assert/strict'; import { resolveInstalledRuntime } from '@yanbot-harness/runtime'; await assert.rejects(resolveInstalledRuntime(), { reason: 'RUNTIME_PACKAGE_MISSING' });",
  );
  cases.push({ name: 'missing-optional-diagnostic', status: 'passed' });
  denied = platform.manifest.packageName;
  const rejected = await consumer('npm-denied-platform');
  await install('npm', rejected, '@yanbot-harness/local');
  await run(
    rejected,
    "import assert from 'node:assert/strict'; import { resolveInstalledRuntime } from '@yanbot-harness/runtime'; await assert.rejects(resolveInstalledRuntime(), { reason: 'RUNTIME_PACKAGE_MISSING' });",
  );
  cases.push({ name: 'platform-401-not-a-successful-runtime', status: 'passed' });
  denied = undefined;
  const kit = JSON.parse(
    (
      await execute(
        process.execPath,
        [path.join(import.meta.dirname, 'build-offline-kit.mjs'), '--common', commonRoot, '--platform', platformRoot],
        { timeout: 60000 },
      )
    ).stdout,
  );
  const offline = JSON.parse(
    (
      await execute(
        process.execPath,
        [
          path.join(kit.directory, 'install-local.mjs'),
          '--prefix',
          path.join(root, 'offline-consumer'),
          '--trusted-key-file',
          kit.externalTestTrust,
        ],
        { cwd: root, env: environment, timeout: 180000, maxBuffer: 8192 },
      )
    ).stdout,
  );
  assert.equal(offline.reference.terminal, 'run.completed');
  cases.push({ name: 'empty-cache-offline-explicit-closure-reference', status: 'passed', evidence: offline });
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = error.message;
  process.exitCode = 1;
} finally {
  await new Promise((resolve) => server.close(resolve));
  report.requests = requests;
  report.artifacts = artifacts.map(({ name, version, file, size, sha256 }) => ({ name, version, file, size, sha256 }));
  await writeFile(path.join(root, 'installation-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, directory: root, cases: cases.length }));
}
