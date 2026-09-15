#!/usr/bin/env node
// Bootstrap trust is out-of-band: obtain this installer and trusted keys from an authorized channel.
import assert from 'node:assert/strict';
import { Buffer, isUtf8 } from 'node:buffer';
import { execFile } from 'node:child_process';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const canonical = (value) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
async function bounded(file, maximum) {
  assert((await lstat(file)).isFile(), 'Kit entry must be a regular file.');
  const handle = await open(file, 'r');
  try {
    const info = await handle.stat();
    assert(info.isFile() && info.size <= maximum, 'Kit entry limit.');
    const bytes = Buffer.alloc(info.size + 1);
    let total = 0;
    while (total < bytes.length) {
      const { bytesRead } = await handle.read(bytes, total, bytes.length - total, null);
      if (!bytesRead) break;
      total += bytesRead;
    }
    assert.equal(total, info.size, 'Kit entry changed.');
    return bytes.subarray(0, total);
  } finally {
    await handle.close();
  }
}

export async function installOfflineKit({ kitDirectory, prefix, trustedKeys, cacheRoot }) {
  assert(
    /^22\./u.test(process.versions.node) && Number(process.versions.node.split('.')[1]) >= 22,
    'Use Node >=22.22.0 <23.',
  );
  const kit = await realpath(kitDirectory);
  const bytes = await bounded(path.join(kit, 'kit-manifest.json'), 65536);
  assert(isUtf8(bytes));
  const m = JSON.parse(bytes.toString('utf8'));
  assert.deepEqual(Object.keys(m), [
    'schemaVersion',
    'version',
    'sourceCommit',
    'sourceLockSha256',
    'target',
    'keyId',
    'testSigning',
    'installer',
    'artifacts',
  ]);
  assert.equal(m.schemaVersion, 1);
  assert(/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/u.test(m.version));
  assert(/^[a-f0-9]{40}$/u.test(m.sourceCommit) && /^[a-f0-9]{64}$/u.test(m.sourceLockSha256));
  assert.equal(m.target, process.platform + '-' + process.arch, 'Kit target mismatch.');
  if (process.platform === 'linux') assert(process.report.getReport().header.glibcVersionRuntime, 'glibc required.');
  assert(typeof m.testSigning === 'boolean' && typeof m.keyId === 'string');
  assert(Object.hasOwn(trustedKeys, m.keyId), 'Unknown kit signer. Supply an authorized external trust root.');
  const key = createPublicKey(trustedKeys[m.keyId]);
  const signature = await bounded(path.join(kit, 'kit-manifest.sig'), 64);
  assert(
    key.asymmetricKeyType === 'ed25519' && signature.length === 64 && verify(null, bytes, key, signature),
    'Kit signature failed.',
  );
  assert(bytes.equals(canonical(m)), 'Noncanonical kit manifest.');
  assert(Array.isArray(m.artifacts) && m.artifacts.length > 4 && m.artifacts.length <= 100);
  assert.deepEqual(Object.keys(m.installer), ['file', 'size', 'sha256']);
  assert.equal(m.installer.file, 'install-local.mjs');
  const paths = new Set();
  const names = new Set();
  const snapshots = [];
  let total = 0;
  for (const artifact of [m.installer, ...m.artifacts]) {
    if (artifact !== m.installer) {
      assert.deepEqual(Object.keys(artifact), ['name', 'version', 'file', 'size', 'sha256']);
      assert(typeof artifact.name === 'string' && !names.has(artifact.name), 'Duplicate package.');
      names.add(artifact.name);
      if (artifact.name.startsWith('@yanbot-harness/')) {
        assert.equal(artifact.version, m.version);
        assert(
          ['contracts', 'sdk', 'runtime', 'local', 'cli', 'runtime-' + m.target].some(
            (name) => artifact.name === '@yanbot-harness/' + name,
          ),
          'Unexpected scoped package.',
        );
      }
      assert(/^[a-zA-Z0-9._-]+\.tgz$/u.test(artifact.file));
    }
    assert(!paths.has(artifact.file));
    paths.add(artifact.file);
    assert(Number.isSafeInteger(artifact.size) && artifact.size >= 0 && artifact.size <= 256 * 1024 * 1024);
    assert(/^[a-f0-9]{64}$/u.test(artifact.sha256));
    total += artifact.size;
    assert(total <= 512 * 1024 * 1024, 'Kit total byte limit.');
    const file = path.join(kit, artifact === m.installer ? '' : 'packages', artifact.file);
    const content = await bounded(file, artifact.size);
    assert(content.length === artifact.size && hash(content) === artifact.sha256, 'Kit artifact digest failed.');
    if (artifact !== m.installer) snapshots.push({ file: artifact.file, content });
  }
  for (const name of ['local', 'sdk', 'contracts', 'runtime', 'runtime-' + m.target])
    assert(names.has('@yanbot-harness/' + name), 'Kit closure missing required package.');
  const destination = path.resolve(prefix);
  // Exclusive creation is the final guard: never install into or overwrite an existing project.
  await mkdir(destination, { mode: 0o700 });
  const localPackages = path.join(destination, '.harness-packages');
  await mkdir(localPackages, { mode: 0o700 });
  for (const snapshot of snapshots)
    await writeFile(path.join(localPackages, snapshot.file), snapshot.content, { flag: 'wx', mode: 0o600 });
  const isolation = await mkdtemp(path.join(tmpdir(), 'harness-offline-install-'));
  const cache = path.join(isolation, 'npm-cache');
  const config = path.join(isolation, 'empty.npmrc');
  const globalConfig = path.join(isolation, 'global.npmrc');
  await writeFile(config, '', { flag: 'wx', mode: 0o600 });
  await writeFile(globalConfig, '', { flag: 'wx', mode: 0o600 });
  await writeFile(path.join(destination, 'package.json'), canonical({ private: true, type: 'module' }), { flag: 'wx' });
  const environment = Object.fromEntries(
    [
      'PATH',
      'Path',
      'SystemRoot',
      'SYSTEMROOT',
      'WINDIR',
      'TEMP',
      'TMP',
      'TMPDIR',
      'HOME',
      'USERPROFILE',
      'LOCALAPPDATA',
      'APPDATA',
      'XDG_CACHE_HOME',
    ].flatMap((name) => (process.env[name] ? [[name, process.env[name]]] : [])),
  );
  Object.assign(environment, {
    npm_config_userconfig: config,
    npm_config_globalconfig: globalConfig,
    npm_config_cache: cache,
    npm_config_registry: 'http://127.0.0.1:9',
    npm_config_offline: 'true',
    npm_config_ignore_scripts: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
  });
  const npmCommand = process.platform === 'win32' ? process.execPath : 'npm';
  const npmPrefix =
    process.platform === 'win32' ? [path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')] : [];
  const runNpm = (arguments_) =>
    execute(npmCommand, [...npmPrefix, ...arguments_], {
      cwd: destination,
      env: environment,
      timeout: 120000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
  let phase = 'npm-version';
  try {
    assert.equal((await runNpm(['--version'])).stdout.trim(), '10.9.8', 'This offline kit requires npm 10.9.8.');
    phase = 'npm-install';
    await runNpm([
      'install',
      '--offline',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--save-exact',
      ...m.artifacts.map((item) => './.harness-packages/' + item.file),
    ]);
    phase = 'reference';
    await writeFile(path.join(destination, '.harness-release-trust.json'), canonical(trustedKeys), {
      flag: 'wx',
      mode: 0o600,
    });
    const smoke = path.join(destination, '.harness-reference-smoke.mjs');
    await writeFile(
      smoke,
      `import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { startManagedRuntime, HARNESS_RELEASE_VERSION } from '@yanbot-harness/local';
assert.equal(HARNESS_RELEASE_VERSION, ${JSON.stringify(m.version)});
const trustedKeys = JSON.parse(await readFile(new URL('./.harness-release-trust.json', import.meta.url), 'utf8'));
const workspace = path.join(import.meta.dirname, '.harness-smoke-workspace');
await mkdir(workspace, { recursive: true });
const runtime = await startManagedRuntime({ reference: true, trustedKeys, startupTimeoutMs: 120000,
  vm: { workspaces: [{ path: workspace, readOnly: true }] }, ${cacheRoot ? 'cacheRoot: ' + JSON.stringify(path.resolve(cacheRoot)) : ''} });
try {
  await runtime.client.health();
  const [adapter] = await runtime.client.listAdapters();
  const grant = await runtime.client.grantWorkspace({ path: workspace });
  const session = await runtime.client.createSession({ adapterId: adapter.manifest.adapterId });
  const run = await runtime.client.createRun(session.sessionId, { prompt: 'Offline Reference smoke', workspaceGrant: grant.grant,
    permissionPolicy: 'read-only', configScopes: [], extensions: [], resume: false });
  let terminal;
  for await (const event of run.events({ signal: AbortSignal.timeout(15000) })) terminal = event.type;
  assert.equal(terminal, 'run.completed');
} finally { await runtime.close(); }
console.log(JSON.stringify({ status: 'passed', terminal: 'run.completed' }));
`,
      { flag: 'wx', mode: 0o600 },
    );
    const result = await execute(process.execPath, [smoke], {
      cwd: destination,
      env: environment,
      timeout: 150000,
      windowsHide: true,
      maxBuffer: 8192,
    });
    assert.equal(JSON.parse(result.stdout).terminal, 'run.completed');
    const evidence = {
      schemaVersion: 1,
      status: 'passed',
      version: m.version,
      target: m.target,
      testSigning: m.testSigning,
      emptyNpmCache: true,
      offline: true,
      ignoreScripts: true,
      reference: { startup: true, health: true, terminal: 'run.completed', close: true },
      packageCount: m.artifacts.length,
    };
    await writeFile(path.join(destination, 'installation-evidence.json'), canonical(evidence), { flag: 'wx' });
    return evidence;
  } catch {
    await writeFile(
      path.join(destination, 'installation-failure.json'),
      canonical({ status: 'failed', phase, isolation }),
      { flag: 'wx' },
    );
    throw new Error(
      'Offline ' +
        phase +
        ' failed. The new consumer directory was retained for diagnosis; no existing project was overwritten.',
    );
  }
}

const canonicalPath = async (file) => {
  const resolved = await realpath(file);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};
if (
  process.argv[1] &&
  (await canonicalPath(process.argv[1])) === (await canonicalPath(fileURLToPath(import.meta.url)))
) {
  const args = process.argv.slice(2);
  assert(
    args.length === 4 && args[0] === '--prefix' && args[2] === '--trusted-key-file',
    'Use node install-local.mjs --prefix NEW_DIRECTORY --trusted-key-file EXTERNAL_TRUST_FILE.',
  );
  const trustedKeys = JSON.parse((await bounded(path.resolve(args[3]), 65536)).toString('utf8'));
  console.log(
    JSON.stringify(await installOfflineKit({ kitDirectory: import.meta.dirname, prefix: args[1], trustedKeys })),
  );
}
