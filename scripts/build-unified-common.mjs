import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { npmInvocation } from './lib/release-platform.mjs';

const execute = promisify(execFile);
const repository = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2).filter((item) => item !== '--');
assert(args.length === 0 || (args.length === 2 && args[0] === '--output-dir'), 'Use --output-dir PARENT.');
const parent = args[1] ? path.resolve(args[1]) : tmpdir();
await mkdir(parent, { recursive: true });
const root = await mkdtemp(path.join(parent, 'harness-common-'));
const packages = path.join(root, 'packages');
await mkdir(packages);
const version = JSON.parse(await readFile(path.join(repository, 'release-version.json'), 'utf8')).version;
const sourceCommit = (await execute('git', ['rev-parse', 'HEAD'], { cwd: repository })).stdout.trim();
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sourceLockSha256 = hash(await readFile(path.join(repository, 'pnpm-lock.yaml')));
const artifacts = [];
const seen = new Map();
const roots = ['packages/contracts', 'packages/sdk', 'packages/runtime', 'packages/local', 'apps/cli'];
const thirdParty = new Map();
const missingOptional = [];

async function locate(from, name) {
  let entry = createRequire(path.join(from, 'package.json')).resolve(name);
  entry = await realpath(entry);
  for (let current = path.dirname(entry); current !== path.dirname(current); current = path.dirname(current)) {
    try {
      const manifest = JSON.parse(await readFile(path.join(current, 'package.json'), 'utf8'));
      if (manifest.name === name) return { directory: current, manifest };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  throw new Error('Cannot identify locked package: ' + name);
}
async function closure(directory, manifest) {
  for (const name of Object.keys({
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
  })) {
    if (name.startsWith('@yanbot-harness/')) {
      assert(
        ['contracts', 'sdk', 'runtime', 'local'].some((part) => name === '@yanbot-harness/' + part) ||
          name.startsWith('@yanbot-harness/runtime-'),
        'Internal implementation leaked into public closure.',
      );
      continue;
    }
    let resolved;
    try {
      resolved = await locate(directory, name);
    } catch (error) {
      if (
        error.code !== 'MODULE_NOT_FOUND' ||
        !(Object.hasOwn(manifest.optionalDependencies ?? {}, name) || manifest.peerDependenciesMeta?.[name]?.optional)
      )
        throw error;
      missingOptional.push({ package: manifest.name, dependency: name });
      continue;
    }
    if (thirdParty.has(name)) {
      assert.equal(
        thirdParty.get(name).manifest.version,
        resolved.manifest.version,
        'Multiple dependency versions require explicit offline resolution design.',
      );
      continue;
    }
    thirdParty.set(name, resolved);
    await closure(resolved.directory, resolved.manifest);
  }
}
async function record(directory, manifest, workspace = false) {
  assert(!seen.has(manifest.name), 'Duplicate package identity.');
  seen.set(manifest.name, manifest.version);
  let metadata;
  if (workspace) {
    await execute(
      process.execPath,
      [process.env.npm_execpath, '--filter', manifest.name, 'pack', '--pack-destination', packages],
      { cwd: repository, timeout: 60000, maxBuffer: 4 * 1024 * 1024 },
    );
    metadata = { filename: manifest.name.replace('@', '').replace('/', '-') + '-' + manifest.version + '.tgz' };
  } else {
    const staging = path.join(root, 'staging-' + artifacts.length);
    await cp(directory, staging, { recursive: true, filter: (file) => path.basename(file) !== 'node_modules' });
    const npm = npmInvocation(['pack', staging, '--ignore-scripts', '--json', '--pack-destination', packages]);
    metadata = JSON.parse(
      (await execute(npm.command, npm.arguments, { cwd: root, timeout: 60000, maxBuffer: 4 * 1024 * 1024 })).stdout,
    )[0];
  }
  const file = path.join(packages, metadata.filename);
  const bytes = await readFile(file);
  artifacts.push({
    name: manifest.name,
    version: manifest.version,
    file: metadata.filename,
    size: (await stat(file)).size,
    sha256: hash(bytes),
  });
}

for (const relative of roots) {
  const directory = path.join(repository, relative);
  const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  assert.equal(manifest.version, version);
  await closure(directory, manifest);
  await record(directory, manifest, true);
}
for (const { directory, manifest } of [...thirdParty.values()].sort((a, b) =>
  a.manifest.name.localeCompare(b.manifest.name),
))
  await record(directory, manifest);
assert.equal(hash(await readFile(path.join(repository, 'pnpm-lock.yaml'))), sourceLockSha256);
await writeFile(
  path.join(root, 'common-manifest.json'),
  JSON.stringify({ schemaVersion: 1, version, sourceCommit, sourceLockSha256, artifacts, missingOptional }, null, 2) +
    '\n',
  { flag: 'wx' },
);
console.log(JSON.stringify({ status: 'passed', directory: root, packages: artifacts.length }));
