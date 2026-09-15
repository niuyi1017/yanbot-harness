// T1 mechanism probe only. These generated packages are NOT product SDK/Runtime implementations.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { URL } from 'node:url';
import { gzipSync } from 'node:zlib';

import { npmInvocation } from './lib/release-platform.mjs';

const executeFile = promisify(execFile);
const version = '0.0.0-probe.1';
const scope = '@harness-install-probe';
const targets = ['darwin-arm64', 'win32-x64', 'linux-x64'];
const target = `${process.platform}-${process.arch}`;
assert(targets.includes(target), `Unsupported probe host: ${target}`);
const args = process.argv.slice(2).filter((item) => item !== '--');
assert(args.length === 0 || (args.length === 2 && args[0] === '--output-dir'), 'Use --output-dir DIRECTORY');
const outputParent = args.length ? path.resolve(args[1]) : tmpdir();
await mkdir(outputParent, { recursive: true });
const root = await mkdtemp(path.join(outputParent, 'harness-distribution-probe-'));
const packages = new Map();
const requests = [];
const cases = [];
let deniedPackage;
let denyEverything = false;
const payload = gzipSync(Buffer.from('T1 opaque payload preservation fixture; not an executable Runtime.\n'));
const pnpmEntry = process.env.npm_execpath;
assert(pnpmEntry && /pnpm/iu.test(pnpmEntry), 'Run this probe via pnpm probe:distribution.');
const report = {
  schemaVersion: 1,
  kind: 'distribution-mechanism-probe',
  scriptSha256: sha256(await readFile(import.meta.filename)),
  target,
  node: process.version,
  probeVersion: version,
  cases,
  limitations: [
    'Synthetic packages only; no production Runtime, signature, lifecycle, or vendor certification.',
    'Only the actual host is exercised; other platform packages contain metadata fixtures.',
    'Offline network evidence covers package-manager offline mode and a deny-all loopback registry, not OS firewall enforcement.',
    'Cross-host lockfile transfer and real Registry authentication require separate acceptance.',
  ],
};

const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  const name = decodeURIComponent(url.pathname.slice(1));
  requests.push({ name, method: request.method });
  // Never log headers: even fixture registries must not capture credentials.
  if (
    denyEverything ||
    name === deniedPackage ||
    (deniedPackage && name === `tarballs/${packages.get(deniedPackage).filename}`)
  ) {
    response.writeHead(403, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'probe access denied' }));
    return;
  }
  const artifact = [...packages.values()].find((item) => `tarballs/${item.filename}` === name);
  if (artifact) {
    response.writeHead(200, { 'content-type': 'application/octet-stream' });
    response.end(artifact.bytes);
    return;
  }
  const item = packages.get(name);
  if (!item) {
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'fixture not found' }));
    return;
  }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(
    JSON.stringify({
      name,
      'dist-tags': { latest: version },
      time: { created: '2020-01-01T00:00:00Z', modified: '2020-01-01T00:00:00Z', [version]: '2020-01-01T00:00:00Z' },
      versions: {
        [version]: {
          ...item.manifest,
          dist: {
            tarball: `${registry}/tarballs/${item.filename}`,
            integrity: `sha512-${createHash('sha512').update(item.bytes).digest('base64')}`,
            shasum: createHash('sha1').update(item.bytes).digest('hex'),
          },
        },
      },
    }),
  );
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const registry = `http://127.0.0.1:${server.address().port}`;

try {
  report.npm = (await runNpm(['--version'], root)).stdout.trim();
  report.pnpm = (await runPnpm(['--version'], root)).stdout.trim();
  assert.equal(report.npm, '10.9.8', 'Probe requires npm 10.9.8; record/review any version change.');
  assert.equal(report.pnpm, '11.10.0', 'Probe requires pnpm 11.10.0.');
  await buildFixtures();
  report.artifacts = [...packages.values()].map(({ manifest, bytes, entries }) => ({
    name: manifest.name,
    version,
    sha256: sha256(bytes),
    entries,
  }));

  await test('npm-pack-preserves-opaque-payload-with-no-loose-dependency-tree', async () => {
    const item = packages.get(`${scope}/runtime-${target}`);
    assert(item.entries.includes('payload/runtime.tar.gz'));
    assert(!item.entries.some((entry) => entry.includes('node_modules')));
  });
  await test('npm-pack-root-node_modules-excluded-but-nested-directory-retained', async () => {
    const item = packages.get(`${scope}/pack-layout`);
    assert(!item.entries.some((entry) => entry.startsWith('node_modules/')));
    assert(item.entries.includes('payload/node_modules/nested-marker/index.js'));
    return { entries: item.entries };
  });

  for (const manager of ['npm', 'pnpm']) {
    await test(`${manager}-registry-platform-selection-and-export-resolution`, async () => {
      const consumer = await newConsumer(`${manager}-registry`, `${scope}/local`);
      const start = requests.length;
      await install(manager, consumer);
      const resolved = await readConsumer(consumer);
      assert.equal(resolved.target, target);
      assert.equal(resolved.payloadSha256, sha256(payload));
      assert.equal(resolved.sdkIdentity, 'shared-sdk-probe');
      const downloaded = requests
        .slice(start)
        .filter((r) => r.name.startsWith('tarballs/'))
        .map((r) => r.name);
      assert(downloaded.some((name) => name.includes(`runtime-${target}-`)));
      for (const other of targets.filter((t) => t !== target)) {
        assert(!downloaded.some((name) => name.includes(`runtime-${other}-`)), `Unexpected target download: ${other}`);
      }
      if (manager === 'pnpm') {
        assert(resolved.manifestPath.includes(`${path.sep}.pnpm${path.sep}`), 'Expected isolated pnpm resolution.');
      }
      return { downloaded, resolvedTarget: resolved.target };
    });

    await test(`${manager}-sdk-only-no-runtime-dependency-or-fetch`, async () => {
      const consumer = await newConsumer(`${manager}-slim`, `${scope}/sdk`);
      const start = requests.length;
      await install(manager, consumer);
      const result = await runNode(
        [
          '--input-type=module',
          '-e',
          `
        import { createRequire } from 'node:module';
        import { sdkIdentity } from '${scope}/sdk';
        const require = createRequire(import.meta.url);
        try { require.resolve('${scope}/runtime'); process.exit(2); }
        catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
        console.log(JSON.stringify({ sdkIdentity }));
      `,
        ],
        consumer,
      );
      assert.equal(JSON.parse(result.stdout).sdkIdentity, 'shared-sdk-probe');
      assert(!requests.slice(start).some((request) => request.name.includes('/runtime')));
    });

    await test(`${manager}-omit-optional-gives-actionable-missing-package`, async () => {
      const consumer = await newConsumer(`${manager}-omit`, `${scope}/local`);
      await install(manager, consumer, manager === 'npm' ? ['--omit=optional'] : ['--no-optional']);
      await assertMissing(consumer);
    });

    await test(`${manager}-denied-platform-package-is-not-a-successful-local-install`, async () => {
      const consumer = await newConsumer(`${manager}-denied`, `${scope}/local`);
      const start = requests.length;
      deniedPackage = `${scope}/runtime-${target}`;
      try {
        const result = await install(manager, consumer, [], true);
        assert(
          requests
            .slice(start)
            .some(
              (request) =>
                request.name === deniedPackage || request.name === `tarballs/${packages.get(deniedPackage).filename}`,
            ),
          'Denied fixture must actually be requested; cached success is not evidence.',
        );
        if (result.code === 0) await assertMissing(consumer);
        return { installExitCode: result.code, resolverRequiredAfterInstall: result.code === 0 };
      } finally {
        deniedPackage = undefined;
      }
    });

    await test(`${manager}-clean-reinstall-from-lockfile`, async () => {
      const first = await newConsumer(`${manager}-lock-source`, `${scope}/local`);
      await install(manager, first);
      const second = await newConsumer(`${manager}-lock-target`, `${scope}/local`);
      const lock = manager === 'npm' ? 'package-lock.json' : 'pnpm-lock.yaml';
      await cp(path.join(first, lock), path.join(second, lock));
      if (manager === 'npm') await runNpm(['ci', '--ignore-scripts', '--no-audit', '--no-fund'], second);
      else await install(manager, second, ['--frozen-lockfile']);
      assert.equal((await readConsumer(second)).target, target);
      return { scope: 'same host, fresh node_modules and package-manager cache/store' };
    });
  }

  await test('npm-empty-cache-offline-explicit-tarball-closure', async () => {
    const consumer = await newConsumer('npm-offline', undefined);
    const names = ['contracts', 'sdk', 'runtime', 'local', `runtime-${target}`].map((name) => `${scope}/${name}`);
    const archives = names.map((name) => packages.get(name).archive);
    const start = requests.length;
    denyEverything = true;
    try {
      await runNpm(['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', ...archives], consumer);
      assert.equal((await readConsumer(consumer)).target, target);
      assert.equal(requests.length, start, 'Offline installation attempted Registry requests.');
      return { registryRequests: 0, explicitLocalTarballs: names.length, cacheInitiallyEmpty: true };
    } finally {
      denyEverything = false;
    }
  });

  await test('npm-offline-missing-required-transitive-tarball-fails', async () => {
    const consumer = await newConsumer('npm-offline-incomplete', undefined);
    const start = requests.length;
    denyEverything = true;
    try {
      const result = await runNpm(
        ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', packages.get(`${scope}/local`).archive],
        consumer,
        true,
      );
      assert.notEqual(result.code, 0);
      assert.equal(requests.length, start);
    } finally {
      denyEverything = false;
    }
  });

  await test('npm-runtime-independent-install-and-relocation', async () => {
    const consumer = await newConsumer('npm-runtime-alone', `${scope}/runtime`);
    await install('npm', consumer);
    const relocated = path.join(root, 'relocated 中文 space &');
    await cp(consumer, relocated, { recursive: true });
    const result = await runNode(
      [
        '--input-type=module',
        '-e',
        `
      import { resolveInstalledRuntime } from '${scope}/runtime';
      console.log(JSON.stringify(await resolveInstalledRuntime()));
    `,
      ],
      relocated,
    );
    assert.equal(JSON.parse(result.stdout).target, target);
  });

  await test('lifecycle-hooks-remain-disabled', async () => {
    assert.equal(await exists(path.join(root, 'HOOK_EXECUTED')), false);
  });
  report.status = cases.every((item) => item.status === 'passed') ? 'passed' : 'failed';
} catch (error) {
  report.status = 'failed';
  report.fatal = safeMessage(error);
  process.exitCode = 1;
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await json(path.join(root, 'report.json'), report);
  console.log(
    JSON.stringify({
      status: report.status,
      passed: cases.filter((c) => c.status === 'passed').length,
      total: cases.length,
      report: path.join(root, 'report.json'),
    }),
  );
  if (report.status !== 'passed') process.exitCode = 1;
}

async function buildFixtures() {
  await fixture(
    'pack-layout',
    { files: ['payload', 'node_modules'] },
    {
      'node_modules/root-marker/index.js': '// Root dependency exclusion probe.\n',
      'payload/node_modules/nested-marker/index.js': '// Nested directory inclusion probe.\n',
    },
  );
  await fixture('contracts', {}, { 'index.js': 'export const protocol = "probe-only";\n' });
  await fixture(
    'sdk',
    { dependencies: { [`${scope}/contracts`]: version } },
    {
      'index.js': `import { protocol } from '${scope}/contracts';
export const sdkIdentity = 'shared-sdk-probe';
export async function inspect(resolver) { return { ...(await resolver()), sdkIdentity, protocol }; }
`,
    },
  );
  for (const current of targets) {
    const [os, cpu] = current.split('-');
    await fixture(
      `runtime-${current}`,
      {
        os: [os],
        cpu: [cpu],
        ...(os === 'linux' ? { libc: ['glibc'] } : {}),
        exports: { './manifest': './runtime-manifest.json' },
        files: ['runtime-manifest.json', 'payload'],
      },
      {
        'runtime-manifest.json': JSON.stringify({
          version,
          target: current,
          payload: 'payload/runtime.tar.gz',
          sha256: sha256(payload),
        }),
        'payload/runtime.tar.gz': payload,
      },
    );
  }
  await fixture(
    'runtime',
    {
      optionalDependencies: Object.fromEntries(targets.map((item) => [`${scope}/runtime-${item}`, version])),
    },
    {
      'index.js': `
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
const require = createRequire(import.meta.url);
export async function resolveInstalledRuntime() {
  const target = process.platform + '-' + process.arch;
  let manifestPath;
  try { manifestPath = require.resolve('${scope}/runtime-' + target + '/manifest'); }
  catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    throw new Error('RUNTIME_PACKAGE_MISSING: ' + target + '@${version}; enable optional dependencies and check Registry access');
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.version !== '${version}' || manifest.target !== target) throw new Error('VERSION_OR_TARGET_MISMATCH');
  const bytes = await readFile(path.join(path.dirname(manifestPath), manifest.payload));
  const payloadSha256 = createHash('sha256').update(bytes).digest('hex');
  if (payloadSha256 !== manifest.sha256) throw new Error('INTEGRITY_FAILED');
  return { target, manifestPath, payloadSha256 };
}
`,
    },
  );
  await fixture(
    'local',
    { dependencies: { [`${scope}/sdk`]: version, [`${scope}/runtime`]: version } },
    {
      'index.js': `import { inspect } from '${scope}/sdk';
import { resolveInstalledRuntime } from '${scope}/runtime';
export * from '${scope}/sdk';
export const inspectLocal = () => inspect(resolveInstalledRuntime);
`,
    },
  );
}

async function fixture(name, extra, files) {
  const directory = path.join(root, 'fixtures', name);
  const manifest = {
    name: `${scope}/${name}`,
    version,
    type: 'module',
    license: 'UNLICENSED',
    files: ['index.js'],
    exports: './index.js',
    ...extra,
    scripts: {
      postinstall: `node -e "require('fs').writeFileSync(process.env.PROBE_HOOK_MARKER, 'unexpected');process.exit(73)"`,
    },
  };
  await json(path.join(directory, 'package.json'), manifest);
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
    await writeFile(path.join(directory, file), content);
  }
  const packs = path.join(root, 'packs');
  await mkdir(packs, { recursive: true });
  const result = await runNpm(['pack', '--ignore-scripts', '--json', '--pack-destination', packs], directory);
  const [packed] = JSON.parse(result.stdout);
  const archive = path.join(packs, packed.filename);
  packages.set(manifest.name, {
    manifest,
    archive,
    filename: packed.filename,
    bytes: await readFile(archive),
    entries: packed.files.map((entry) => entry.path),
  });
}

async function newConsumer(name, dependency) {
  const directory = path.join(root, 'consumers', name);
  await json(path.join(directory, 'package.json'), {
    private: true,
    type: 'module',
    ...(dependency ? { dependencies: { [dependency]: version } } : {}),
  });
  await writeFile(path.join(directory, 'pnpm-workspace.yaml'), 'packages: []\nminimumReleaseAge: 0\n');
  return directory;
}

async function install(manager, directory, extra = [], allowFailure = false) {
  const flags = [
    'install',
    '--ignore-scripts',
    ...(manager === 'npm'
      ? ['--no-audit', '--no-fund']
      : extra.includes('--frozen-lockfile')
        ? []
        : ['--no-frozen-lockfile']),
    ...extra,
  ];
  return manager === 'npm' ? runNpm(flags, directory, allowFailure) : runPnpm(flags, directory, allowFailure);
}

async function assertMissing(directory) {
  const result = await runNode(
    [
      '--input-type=module',
      '-e',
      `
    import { inspectLocal } from '${scope}/local';
    try { await inspectLocal(); process.exit(2); }
    catch (error) { console.log(error.message); if (!error.message.startsWith('RUNTIME_PACKAGE_MISSING:')) process.exit(3); }
  `,
    ],
    directory,
  );
  assert.match(result.stdout, /RUNTIME_PACKAGE_MISSING:/u);
}

async function readConsumer(directory) {
  const result = await runNode(
    [
      '--input-type=module',
      '-e',
      `
    import { inspectLocal } from '${scope}/local';
    console.log(JSON.stringify(await inspectLocal()));
  `,
    ],
    directory,
  );
  return JSON.parse(result.stdout);
}

async function environment(directory) {
  const env = Object.fromEntries(
    [
      'PATH',
      'HOME',
      'USERPROFILE',
      'SystemRoot',
      'SYSTEMROOT',
      'WINDIR',
      'ComSpec',
      'PATHEXT',
      'APPDATA',
      'LOCALAPPDATA',
      'TEMP',
      'TMP',
      'TMPDIR',
    ].flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : [])),
  );
  const userConfig = path.join(root, 'user.npmrc');
  const globalConfig = path.join(root, 'global.npmrc');
  await writeFile(userConfig, '');
  await writeFile(globalConfig, '');
  return {
    ...env,
    CI: 'true',
    NO_COLOR: '1',
    COREPACK_ENABLE_NETWORK: '0',
    npm_config_registry: registry,
    npm_config_userconfig: userConfig,
    npm_config_globalconfig: globalConfig,
    npm_config_cache: path.join(directory, '.npm-cache'),
    npm_config_fetch_retries: '0',
    npm_config_fetch_timeout: '10000',
    PROBE_HOOK_MARKER: path.join(root, 'HOOK_EXECUTED'),
  };
}

async function runNpm(arguments_, directory, allowFailure = false) {
  const invocation = npmInvocation(arguments_);
  return command(invocation.command, invocation.arguments, directory, allowFailure);
}

async function runPnpm(arguments_, directory, allowFailure = false) {
  const options = arguments_.includes('--version')
    ? []
    : [
        '--store-dir',
        path.join(directory, '.pnpm-store'),
        '--cache-dir',
        path.join(directory, '.pnpm-cache'),
        '--registry',
        registry,
      ];
  return command(process.execPath, [pnpmEntry, ...arguments_, ...options], directory, allowFailure);
}

async function runNode(arguments_, directory) {
  return command(process.execPath, arguments_, directory);
}

async function command(executable, arguments_, directory, allowFailure = false) {
  try {
    return {
      code: 0,
      ...(await executeFile(executable, arguments_, {
        cwd: directory,
        env: await environment(directory),
        timeout: 60_000,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      })),
    };
  } catch (error) {
    if (allowFailure && Number.isInteger(error.code) && !error.killed)
      return { code: error.code, stdout: error.stdout, stderr: error.stderr };
    throw new Error(
      `Probe command failed (${path.basename(executable)} ${arguments_[0] ?? ''}): ${error.stderr || error.message}`,
    );
  }
}

async function test(name, action) {
  try {
    const details = await action();
    cases.push({ name, status: 'passed', ...(details ? { details } : {}) });
    console.log(`PASS ${name}`);
  } catch (error) {
    cases.push({ name, status: 'failed', error: safeMessage(error) });
    console.log(`FAIL ${name}: ${safeMessage(error)}`);
  }
}

function safeMessage(error) {
  return String(error.message).replaceAll(root, '<probe-root>').slice(0, 4000);
}
function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
async function json(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}
async function exists(file) {
  try {
    await readFile(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
