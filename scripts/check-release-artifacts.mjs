import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, '..');
const version = JSON.parse(
  await readFile(path.join(repositoryRoot, 'packages/contracts/package.json'), 'utf8'),
).version;
const releaseRoot = path.resolve(process.argv[2] ?? path.join(repositoryRoot, 'release', version));
const violations = [];

assertReleaseRoot(releaseRoot);
const manifest = JSON.parse(await readFile(path.join(releaseRoot, 'manifest.json'), 'utf8'));
if (manifest.version !== version || manifest.protocolVersion !== '1.0.0') violations.push('manifest version mismatch');

const checksums = await readChecksums();
const releaseFiles = (await filesIn(releaseRoot)).filter((file) => path.basename(file) !== 'SHA256SUMS');
for (const file of releaseFiles) {
  const relative = path.relative(releaseRoot, file);
  if (!checksums.has(relative)) violations.push(`${relative}: missing checksum`);
}
for (const [relative, expected] of checksums) {
  const absolute = path.join(releaseRoot, relative);
  try {
    if ((await sha256(absolute)) !== expected) violations.push(`${relative}: checksum mismatch`);
  } catch {
    violations.push(`${relative}: checksum target missing`);
  }
}

for (const artifact of manifest.artifacts ?? []) {
  const absolute = path.join(releaseRoot, artifact.path);
  try {
    const info = await stat(absolute);
    if (info.size !== artifact.size || (await sha256(absolute)) !== artifact.sha256) {
      violations.push(`${artifact.path}: manifest metadata mismatch`);
    }
  } catch {
    violations.push(`${artifact.path}: manifest artifact missing`);
  }
}

const packageExpectations = new Map([
  ['@yanbot-harness/contracts', ['zod']],
  ['@yanbot-harness/sdk', ['@yanbot-harness/contracts']],
  ['@yanbot-harness/cli', ['@yanbot-harness/sdk']],
]);
for (const archive of (await filesIn(path.join(releaseRoot, 'packages'))).filter((file) => file.endsWith('.tgz'))) {
  const packageJson = JSON.parse((await executeFile('tar', ['-xOf', archive, 'package/package.json'])).stdout);
  if (packageJson.name === 'zod') {
    if (packageJson.version !== '4.4.3') violations.push(`${path.basename(archive)}: unsupported Zod version`);
    continue;
  }
  if (packageJson.private === true) violations.push(`${path.basename(archive)}: private is true`);
  if (packageJson.version !== version) violations.push(`${path.basename(archive)}: version mismatch`);
  const expectedDependencies = packageExpectations.get(packageJson.name);
  if (!expectedDependencies) {
    violations.push(`${path.basename(archive)}: unexpected package name`);
  } else if (
    JSON.stringify(Object.keys(packageJson.dependencies ?? {}).sort()) !== JSON.stringify(expectedDependencies.sort())
  ) {
    violations.push(`${path.basename(archive)}: production dependency boundary mismatch`);
  }
  if (JSON.stringify(packageJson).includes('workspace:'))
    violations.push(`${path.basename(archive)}: workspace protocol`);
  const entries = (await executeFile('tar', ['-tzf', archive])).stdout.trim().split('\n');
  for (const entry of entries) {
    if (!/^package\/(?:dist\/[^/]+\.(?:js|d\.ts)|README\.md|LICENSE|package\.json)$/u.test(entry)) {
      violations.push(`${path.basename(archive)}: unexpected entry ${entry}`);
    }
  }
}

const runtimeArchives = (await filesIn(path.join(releaseRoot, 'runtime'))).filter((file) => file.endsWith('.tar.gz'));
if (runtimeArchives.length !== 1) violations.push('expected exactly one Runtime archive');
for (const archive of runtimeArchives) {
  const entries = (await executeFile('tar', ['-tzf', archive], { maxBuffer: 50 * 1024 * 1024 })).stdout
    .trim()
    .split('\n');
  for (const entry of entries) checkEntry(entry, path.basename(archive));
  const extractionRoot = await mkdtemp(path.join(releaseRoot, '.artifact-check-'));
  try {
    await executeFile('tar', ['-xzf', archive, '-C', extractionRoot], { maxBuffer: 50 * 1024 * 1024 });
    for (const file of await filesIn(extractionRoot)) await scanTextFile(file, path.relative(extractionRoot, file));
  } finally {
    await rm(extractionRoot, { recursive: true, force: true });
  }
}

for (const file of releaseFiles.filter((item) => !/\.(?:tgz|tar\.gz)$/u.test(item))) {
  await scanTextFile(file, path.relative(releaseRoot, file));
}

if (violations.length > 0) {
  console.error(violations.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Release artifact checks passed for ${version}.`);
}

async function readChecksums() {
  const result = new Map();
  const lines = (await readFile(path.join(releaseRoot, 'SHA256SUMS'), 'utf8')).trim().split('\n');
  for (const line of lines) {
    const match = /^([a-f0-9]{64}) {2}(.+)$/u.exec(line);
    if (!match) violations.push(`invalid checksum line: ${line}`);
    else result.set(match[2], match[1]);
  }
  return result;
}

function checkEntry(entry, archive) {
  if (
    /(?:^|\/)\.git(?:\/|$)|(?:^|\/)\.env(?:\.|\/|$)|\.(?:map|pem|key|p12|pfx)$/iu.test(entry) ||
    /file\+{3}|\/Users\//u.test(entry)
  ) {
    violations.push(`${archive}: forbidden entry ${entry}`);
  }
  if (/node_modules\/@yanbot-harness\/[^/]+\/(?:src|test|tests|__tests__)\//u.test(entry)) {
    violations.push(`${archive}: internal source/test entry ${entry}`);
  }
}

async function scanTextFile(file, label) {
  const info = await stat(file);
  if (info.size > 2 * 1024 * 1024 || !isTextFile(file)) return;
  const content = await readFile(file, 'utf8');
  if (/ck_[A-Za-z0-9._-]{40,}/u.test(content)) violations.push(`${label}: credential-like value`);
  if (
    content.includes('workspace:') &&
    (!label.includes('node_modules/') || label.includes('node_modules/@yanbot-harness/'))
  ) {
    violations.push(`${label}: workspace protocol`);
  }
  if (content.includes(repositoryRoot)) violations.push(`${label}: local repository path`);
}

function isTextFile(file) {
  return /(?:\.(?:cjs|d\.ts|js|json|md|mjs|sh|txt|yaml|yml)|yanbot-harness-runtime)$/u.test(file);
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

function assertReleaseRoot(directory) {
  const parent = path.join(repositoryRoot, 'release');
  if (path.dirname(directory) !== parent || path.basename(directory) !== version) {
    throw new Error('Release checks must target the versioned repository release directory.');
  }
}
