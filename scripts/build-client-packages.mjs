import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import { npmInvocation } from './lib/release-platform.mjs';

const executeFile = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, '..');
const requireFromContracts = createRequire(path.join(repositoryRoot, 'packages/contracts/package.json'));
const contractsPackage = await readJson('packages/contracts/package.json');
const sdkPackage = await readJson('packages/sdk/package.json');
const cliPackage = await readJson('apps/cli/package.json');
const version = contractsPackage.version;
const positionalArguments = process.argv.slice(2).filter((argument) => argument !== '--' && !argument.startsWith('--'));
const outputRoot = path.resolve(positionalArguments[0] ?? path.join(repositoryRoot, 'release-work', 'common', version));
const packagesDirectory = path.join(outputRoot, 'packages');
const skipBuild = process.argv.includes('--skip-build');

assertVersions();
assertDedicatedOutput(outputRoot);
await rm(outputRoot, { recursive: true, force: true });
await mkdir(packagesDirectory, { recursive: true, mode: 0o700 });

if (!skipBuild) await runPnpm(['build']);
for (const packageName of [contractsPackage.name, sdkPackage.name, cliPackage.name]) {
  await runPnpm(['--filter', packageName, 'pack', '--pack-destination', packagesDirectory]);
}

const zodRoot = path.dirname(requireFromContracts.resolve('zod/package.json'));
const zodPackRoot = await mkdtemp(path.join(tmpdir(), 'yanbot-harness-zod-pack-'));
try {
  const zodStaging = path.join(zodPackRoot, 'zod');
  await cp(zodRoot, zodStaging, { recursive: true, dereference: true });
  const npm = npmInvocation(['pack', zodStaging, '--pack-destination', packagesDirectory]);
  await executeFile(npm.command, npm.arguments, {
    cwd: repositoryRoot,
    env: { ...process.env, CI: 'true' },
    maxBuffer: 20 * 1024 * 1024,
  });
} finally {
  await rm(zodPackRoot, { recursive: true, force: true });
}

const artifacts = [];
for (const file of (await filesIn(packagesDirectory)).sort()) {
  const info = await stat(file);
  artifacts.push({
    path: path.relative(outputRoot, file).split(path.sep).join('/'),
    sha256: await sha256(file),
    size: info.size,
  });
}
await writeFile(
  path.join(outputRoot, 'client-packages.json'),
  `${JSON.stringify({ schemaVersion: 1, version, artifacts }, null, 2)}\n`,
);
process.stdout.write(`${outputRoot}\n`);

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
  if (![sdkPackage.version, cliPackage.version].every((item) => item === version)) {
    throw new Error('Contracts, SDK, and CLI versions must match.');
  }
}

function assertDedicatedOutput(directory) {
  const relative = path.relative(repositoryRoot, directory);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Client package output must be a dedicated directory inside the repository.');
  }
}
