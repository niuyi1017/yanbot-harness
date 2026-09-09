import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, '..');
const requireFromContracts = createRequire(path.join(repositoryRoot, 'packages/contracts/package.json'));
const contractsPackage = await readJson('packages/contracts/package.json');
const sdkPackage = await readJson('packages/sdk/package.json');
const cliPackage = await readJson('apps/cli/package.json');
const runtimePackage = await readJson('apps/local-runtime/package.json');
const codeBuddyPackage = await readJson('packages/adapter-codebuddy/package.json');
const vendorSdkPackageName = ['@tencent-ai', 'agent-sdk'].join('/');
const version = contractsPackage.version;
const releaseRoot = path.join(repositoryRoot, 'release', version);
const skipCheck = process.argv.includes('--skip-check');

assertVersions();
assertReleaseRoot(releaseRoot);
await rm(releaseRoot, { recursive: true, force: true });
await mkdir(path.join(releaseRoot, 'packages'), { recursive: true, mode: 0o700 });
await mkdir(path.join(releaseRoot, 'runtime'), { recursive: true, mode: 0o700 });
await mkdir(path.join(releaseRoot, 'examples/sdk-basic/src'), { recursive: true, mode: 0o700 });
await mkdir(path.join(releaseRoot, 'docs'), { recursive: true, mode: 0o700 });

if (!skipCheck) await runPnpm(['check']);
for (const packageName of [contractsPackage.name, sdkPackage.name, cliPackage.name]) {
  await runPnpm(['--filter', packageName, 'pack', '--pack-destination', path.join(releaseRoot, 'packages')]);
}
const zodRoot = path.dirname(requireFromContracts.resolve('zod/package.json'));
await executeFile(
  process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['pack', zodRoot, '--pack-destination', path.join(releaseRoot, 'packages')],
  { cwd: repositoryRoot, env: { ...process.env, CI: 'true' }, maxBuffer: 20 * 1024 * 1024 },
);
await executeFile(
  process.execPath,
  [path.join(repositoryRoot, 'scripts/build-runtime-bundle.mjs'), path.join(releaseRoot, 'runtime')],
  {
    cwd: repositoryRoot,
    env: process.env,
    maxBuffer: 20 * 1024 * 1024,
  },
);

await copyFile(
  path.join(repositoryRoot, 'docs/delivery/compatibility.md'),
  path.join(releaseRoot, 'docs/compatibility.md'),
);
await copyFile(
  path.join(repositoryRoot, 'docs/architecture/codebuddy-capability-matrix.md'),
  path.join(releaseRoot, 'docs/codebuddy-capability-matrix.md'),
);
await copyFile(
  path.join(repositoryRoot, 'docs/delivery/handoff-checklist.md'),
  path.join(releaseRoot, 'docs/handoff-checklist.md'),
);
await copyFile(path.join(repositoryRoot, 'CHANGELOG.md'), path.join(releaseRoot, 'RELEASE_NOTES.md'));
const quickstartSource = path.join(repositoryRoot, 'docs/delivery/sdk-cli-quickstart.md');
try {
  await copyFile(quickstartSource, path.join(releaseRoot, 'QUICKSTART.md'));
} catch (error) {
  if (!isMissing(error)) throw error;
}

const sdkArchive = `yanbot-harness-sdk-${version}.tgz`;
await writeFile(
  path.join(releaseRoot, 'examples/sdk-basic/package.json'),
  `${JSON.stringify(
    {
      name: 'yanbot-harness-sdk-basic-consumer',
      private: true,
      type: 'module',
      engines: { node: sdkPackage.engines.node },
      dependencies: { '@yanbot-harness/sdk': `file:../../packages/${sdkArchive}` },
    },
    null,
    2,
  )}\n`,
);
await copyFile(
  path.join(repositoryRoot, 'examples/sdk-basic/src/index.ts'),
  path.join(releaseRoot, 'examples/sdk-basic/src/index.ts'),
);

const gitCommit = (await executeFile('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot })).stdout.trim();
const gitDirty = Boolean((await executeFile('git', ['status', '--porcelain'], { cwd: repositoryRoot })).stdout.trim());
const artifactFiles = [
  ...(await filesIn(path.join(releaseRoot, 'packages'))),
  ...(await filesIn(path.join(releaseRoot, 'runtime'))),
].sort();
const artifacts = [];
for (const absolute of artifactFiles) {
  const info = await stat(absolute);
  artifacts.push({
    path: path.relative(releaseRoot, absolute),
    sha256: await sha256(absolute),
    size: info.size,
  });
}
await writeFile(
  path.join(releaseRoot, 'manifest.json'),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      version,
      protocolVersion: '1.0.0',
      gitCommit,
      gitDirty,
      builtAt: new Date().toISOString(),
      node: process.version,
      pnpm: '11.10.0',
      platform: process.platform,
      arch: process.arch,
      components: {
        contracts: contractsPackage.version,
        sdk: sdkPackage.version,
        cli: cliPackage.version,
        runtime: runtimePackage.version,
        codeBuddySdk: codeBuddyPackage.dependencies[vendorSdkPackageName],
      },
      certifiedTargets: ['darwin-arm64', 'linux-x64'],
      artifacts,
      capabilityMatrix: 'docs/codebuddy-capability-matrix.md',
    },
    null,
    2,
  )}\n`,
);

const checksumFiles = (await filesIn(releaseRoot))
  .filter((file) => path.basename(file) !== 'SHA256SUMS')
  .sort((left, right) => path.relative(releaseRoot, left).localeCompare(path.relative(releaseRoot, right)));
const checksumLines = [];
for (const file of checksumFiles) checksumLines.push(`${await sha256(file)}  ${path.relative(releaseRoot, file)}`);
await writeFile(path.join(releaseRoot, 'SHA256SUMS'), `${checksumLines.join('\n')}\n`);
process.stdout.write(`${releaseRoot}\n`);

async function readJson(relative) {
  return JSON.parse(await readFile(path.join(repositoryRoot, relative), 'utf8'));
}

async function runPnpm(arguments_) {
  const npmExecPath = process.env.npm_execpath;
  const command = npmExecPath ? process.execPath : process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const args = npmExecPath ? [npmExecPath, ...arguments_] : arguments_;
  await executeFile(command, args, {
    cwd: repositoryRoot,
    env: { ...process.env, CI: 'true' },
    maxBuffer: 50 * 1024 * 1024,
  });
}

async function filesIn(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await filesIn(absolute)));
    else result.push(absolute);
  }
  return result;
}

async function sha256(file) {
  return createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
}

function assertVersions() {
  if (![sdkPackage.version, cliPackage.version, runtimePackage.version].every((item) => item === version)) {
    throw new Error('Contracts, SDK, CLI, and Runtime versions must match.');
  }
}

function assertReleaseRoot(directory) {
  const parent = path.join(repositoryRoot, 'release');
  if (path.dirname(directory) !== parent || path.basename(directory) !== version) {
    throw new Error('Refusing to replace an unexpected release directory.');
  }
}

function isMissing(error) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
