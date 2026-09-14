import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import { createZipArchive, findRuntimeArchive } from './lib/release-platform.mjs';

const executeFile = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, '..');
const contractsPackage = await readJson('packages/contracts/package.json');
const sdkPackage = await readJson('packages/sdk/package.json');
const cliPackage = await readJson('apps/cli/package.json');
const runtimePackage = await readJson('apps/local-runtime/package.json');
const codeBuddyPackage = await readJson('packages/adapter-codebuddy/package.json');
const vendorSdkPackageName = ['@tencent-ai', 'agent-sdk'].join('/');
const version = contractsPackage.version;
const positionalArguments = process.argv.slice(2).filter((argument) => argument !== '--' && !argument.startsWith('--'));
const commonRoot = path.resolve(positionalArguments[0] ?? path.join(repositoryRoot, 'release-work', 'common', version));
const runtimeRoot = path.resolve(positionalArguments[1] ?? path.join(repositoryRoot, 'release-work', 'runtime'));
const releaseRoot = path.resolve(positionalArguments[2] ?? path.join(repositoryRoot, 'release', version));

assertVersions();
assertReleaseRoot(releaseRoot);
const commonManifest = JSON.parse(await readFile(path.join(commonRoot, 'client-packages.json'), 'utf8'));
await verifyCommonPackages(commonManifest);
const runtimeArchive = await findRuntimeArchive(runtimeRoot);
const runtimeArchiveName = path.basename(runtimeArchive);
const target = runtimeTarget(runtimeArchiveName);

await rm(releaseRoot, { recursive: true, force: true });
await mkdir(path.join(releaseRoot, 'runtime'), { recursive: true, mode: 0o700 });
await mkdir(path.join(releaseRoot, 'examples/sdk-basic/src'), { recursive: true, mode: 0o700 });
await mkdir(path.join(releaseRoot, 'docs'), { recursive: true, mode: 0o700 });
await cp(path.join(commonRoot, 'packages'), path.join(releaseRoot, 'packages'), { recursive: true });
await copyFile(runtimeArchive, path.join(releaseRoot, 'runtime', runtimeArchiveName));

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
  artifacts.push({ path: relativePath(releaseRoot, absolute), sha256: await sha256(absolute), size: info.size });
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
      target,
      components: {
        contracts: contractsPackage.version,
        sdk: sdkPackage.version,
        cli: cliPackage.version,
        runtime: runtimePackage.version,
        codeBuddySdk: codeBuddyPackage.dependencies[vendorSdkPackageName],
      },
      certifiedTargets: ['darwin-arm64', 'linux-x64', 'win32-x64'],
      artifacts,
      capabilityMatrix: 'docs/codebuddy-capability-matrix.md',
    },
    null,
    2,
  )}\n`,
);

const checksumFiles = (await filesIn(releaseRoot))
  .filter((file) => path.basename(file) !== 'SHA256SUMS')
  .sort((left, right) => relativePath(releaseRoot, left).localeCompare(relativePath(releaseRoot, right)));
const checksumLines = [];
for (const file of checksumFiles) checksumLines.push(`${await sha256(file)}  ${relativePath(releaseRoot, file)}`);
await writeFile(path.join(releaseRoot, 'SHA256SUMS'), `${checksumLines.join('\n')}\n`);

const bundleName = `yanbot-harness-${version}-${target}`;
const outerArchive = path.join(path.dirname(releaseRoot), `${bundleName}.zip`);
const outerChecksum = `${outerArchive}.sha256`;
const outerStagingRoot = path.join(path.dirname(releaseRoot), `.outer-staging-${process.pid}`);
await rm(outerStagingRoot, { recursive: true, force: true });
await rm(outerArchive, { force: true });
await rm(outerChecksum, { force: true });
try {
  await mkdir(outerStagingRoot, { recursive: true, mode: 0o700 });
  await cp(releaseRoot, path.join(outerStagingRoot, bundleName), { recursive: true });
  await createZipArchive(path.join(outerStagingRoot, bundleName), outerArchive);
} finally {
  await rm(outerStagingRoot, { recursive: true, force: true });
}
await writeFile(outerChecksum, `${await sha256(outerArchive)}  ${path.basename(outerArchive)}\n`);
process.stdout.write(`${JSON.stringify({ releaseRoot, outerArchive, outerChecksum, target })}\n`);

async function verifyCommonPackages(manifest) {
  if (manifest.schemaVersion !== 1 || manifest.version !== version || !Array.isArray(manifest.artifacts)) {
    throw new Error('Client package manifest is incompatible with this release.');
  }
  for (const artifact of manifest.artifacts) {
    if (typeof artifact.path !== 'string' || typeof artifact.sha256 !== 'string' || typeof artifact.size !== 'number') {
      throw new Error('Client package manifest contains an invalid artifact.');
    }
    const absolute = path.resolve(commonRoot, artifact.path);
    const relative = path.relative(commonRoot, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Client package manifest contains an unsafe artifact path.');
    }
    const info = await stat(absolute);
    if (info.size !== artifact.size || (await sha256(absolute)) !== artifact.sha256) {
      throw new Error(`Client package artifact failed integrity verification: ${artifact.path}`);
    }
  }
}

async function readJson(relative) {
  return JSON.parse(await readFile(path.join(repositoryRoot, relative), 'utf8'));
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

function runtimeTarget(archiveName) {
  const prefix = `yanbot-harness-runtime-${version}-`;
  const suffix = archiveName.endsWith('.tar.gz') ? '.tar.gz' : archiveName.endsWith('.zip') ? '.zip' : undefined;
  if (!archiveName.startsWith(prefix) || !suffix) throw new Error('Runtime archive name does not match this release.');
  const target = archiveName.slice(prefix.length, -suffix.length);
  if (!/^(?:darwin|linux|win32)-(?:arm64|x64)$/u.test(target)) {
    throw new Error('Runtime archive target is unsupported.');
  }
  return target;
}

function assertVersions() {
  if (![sdkPackage.version, cliPackage.version, runtimePackage.version].every((item) => item === version)) {
    throw new Error('Contracts, SDK, CLI, and Runtime versions must match.');
  }
}

function assertReleaseRoot(directory) {
  const parent = path.join(repositoryRoot, 'release');
  if (path.dirname(directory) !== parent || path.basename(directory) !== version) {
    throw new Error('Release assembly must target the versioned repository release directory.');
  }
}

function relativePath(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function isMissing(error) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
