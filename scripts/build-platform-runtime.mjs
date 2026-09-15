import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { sha256 } from '../packages/runtime/lib/archive.mjs';
import { currentTarget, resolvePlatformDirectory } from '../packages/runtime/lib/index.mjs';
import { VERSION } from '../packages/runtime/lib/manifest.mjs';
import { startManagedRuntime } from '../packages/local/dist/index.js';
import { buildPlatformPackage } from './lib/build-platform-package.mjs';
import { stageRuntime } from './lib/runtime-staging.mjs';
import { npmInvocation } from './lib/release-platform.mjs';

const execute = promisify(execFile);
const repository = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2).filter((arg) => arg !== '--');
const testSigning = args.includes('--test-signing');
const skipBuild = args.includes('--skip-build');
for (const flag of ['--test-signing', '--skip-build']) if (args.includes(flag)) args.splice(args.indexOf(flag), 1);
assert(
  args.length === 0 || (args.length === 2 && args[0] === '--output-dir'),
  'Use --output-dir PARENT [--test-signing] [--skip-build].',
);
const outputParent = args[1] ? path.resolve(args[1]) : tmpdir();
await mkdir(outputParent, { recursive: true });
const root = await mkdtemp(path.join(outputParent, 'harness-platform-build-'));
const target = currentTarget();
const releaseVersion = JSON.parse(await readFile(path.join(repository, 'release-version.json'), 'utf8'));
assert.equal(releaseVersion.version, VERSION);
const runGit = async (...arguments_) =>
  (await execute('git', arguments_, { cwd: repository, timeout: 15000 })).stdout.trim();
const sourceCommit = await runGit('rev-parse', 'HEAD');
const sourceStatus = await runGit('status', '--porcelain', '--untracked-files=all');
assert(testSigning || sourceStatus === '', 'Release signing requires a clean source tree.');
const sourceLockSha256 = sha256(await readFile(path.join(repository, 'pnpm-lock.yaml')));
let privateKey;
const keyId = testSigning ? 'ephemeral-test-only' : process.env.HARNESS_RELEASE_KEY_ID;
if (testSigning) privateKey = generateKeyPairSync('ed25519').privateKey;
else {
  assert(
    keyId && process.env.HARNESS_RELEASE_KEY_FILE,
    'Supply an authorized signing identity or use --test-signing for isolated tests.',
  );
  const keyFile = process.env.HARNESS_RELEASE_KEY_FILE;
  const info = await stat(keyFile);
  assert(process.platform === 'win32' || (info.mode & 0o077) === 0, 'Signing key file must be private.');
  privateKey = createPrivateKey(await readFile(keyFile));
}
const trustedKeys = { [keyId]: createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }) };
const report = {
  schemaVersion: 1,
  kind: 'platform-runtime-build',
  target,
  version: VERSION,
  sourceCommit,
  sourceLockSha256,
  gitDirty: Boolean(sourceStatus),
  testSigning,
  publishAuthorized: false,
};
try {
  if (!skipBuild)
    await execute(process.execPath, [process.env.npm_execpath, 'build'], {
      cwd: repository,
      timeout: 120000,
      maxBuffer: 8 * 1024 * 1024,
    });
  const staged = await stageRuntime({ repository, root, pnpmEntry: process.env.npm_execpath });
  const platform = path.join(root, 'platform');
  const manifest = await buildPlatformPackage({
    source: staged.directory,
    destination: platform,
    release: { version: VERSION, sourceCommit, sourceLockSha256 },
    target,
    privateKey,
    keyId,
  });
  const npm = npmInvocation(['pack', platform, '--ignore-scripts', '--json', '--pack-destination', root]);
  const packed = JSON.parse(
    (await execute(npm.command, npm.arguments, { cwd: root, timeout: 120000, maxBuffer: 8 * 1024 * 1024 })).stdout,
  )[0];
  const tarball = path.join(root, packed.filename);
  const cacheRoot = path.join(root, 'reference-cache');
  const handle = await startManagedRuntime({
    reference: true,
    startupTimeoutMs: 120000,
    runtimeResolver: ({ signal }) =>
      resolvePlatformDirectory({ directory: platform, target, trustedKeys, cacheRoot, signal }),
  });
  try {
    await handle.client.health();
    await handle.client.listAdapters();
  } finally {
    await handle.close();
  }
  assert.equal(sha256(await readFile(path.join(repository, 'pnpm-lock.yaml'))), sourceLockSha256);
  assert.equal(await runGit('rev-parse', 'HEAD'), sourceCommit);
  assert.equal(
    await runGit('status', '--porcelain', '--untracked-files=all'),
    sourceStatus,
    'Source tree changed during build.',
  );
  Object.assign(report, {
    status: 'passed',
    artifact: { file: packed.filename, size: (await stat(tarball)).size, sha256: sha256(await readFile(tarball)) },
    manifest,
    normalized: {
      files: staged.normalization.after.files,
      bytes: staged.normalization.after.bytes,
      sha256: staged.normalization.after.sha256,
    },
    reference: { resolver: 'verified platform directory', startup: true, health: true, close: true },
    limitations: [
      'No production trust root or Registry approval.',
      'Reference only; no real-vendor or complete process-tree certification.',
    ],
  });
  if (testSigning)
    await writeFile(path.join(root, 'test-trust.json'), JSON.stringify(trustedKeys, null, 2) + '\n', { flag: 'wx' });
} catch (error) {
  report.status = 'failed';
  report.error = error.message;
  process.exitCode = 1;
} finally {
  await writeFile(path.join(root, 'build-report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ status: report.status, directory: root, error: report.error }));
}
