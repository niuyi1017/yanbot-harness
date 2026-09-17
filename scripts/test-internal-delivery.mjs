import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { inventoryFiles, validateArchiveEntries, verifyChecksums } from './lib/internal-delivery.mjs';
import { extractRuntimeArchive } from './lib/release-platform.mjs';

const execute = promisify(execFile);

test('delivery inventory rejects links and detects changed or unlisted files', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'delivery-integrity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'a.txt'), 'a');
  const [{ sha256 }] = await inventoryFiles(root);
  await writeFile(path.join(root, 'SHA256SUMS'), `${sha256}  a.txt\n`);
  await verifyChecksums(root);
  await writeFile(path.join(root, 'extra.txt'), 'extra');
  await assert.rejects(verifyChecksums(root), /changed/u);
  await symlink('a.txt', path.join(root, 'linked.txt'));
  await assert.rejects(inventoryFiles(root), /symbolic/u);
});

test('archive entry validation rejects traversal and case collisions', () => {
  validateArchiveEntries(['delivery/', 'delivery/file'], 'delivery');
  validateArchiveEntries(['delivery/file'], 'delivery');
  assert.throws(() => validateArchiveEntries(['delivery/', '../escape'], 'delivery'));
  assert.throws(() => validateArchiveEntries(['delivery/', 'delivery/A', 'delivery/a'], 'delivery'), /Duplicate/u);
});

test('builder emits one platform ZIP with local as the root package', async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'delivery-builder-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const commonRoot = path.join(fixture, 'common');
  await mkdir(path.join(commonRoot, 'packages'), { recursive: true });
  const version = '0.1.0-preview.3';
  const sourceCommit = 'a'.repeat(40);
  const sourceLockSha256 = 'b'.repeat(64);
  const artifacts = [];
  for (const name of ['contracts', 'sdk', 'runtime', 'local', 'fixture-dependency']) {
    const file = name + '.tgz';
    const bytes = Buffer.from(name);
    await writeFile(path.join(commonRoot, 'packages', file), bytes);
    const { createHash } = await import('node:crypto');
    artifacts.push({
      name: name === 'fixture-dependency' ? name : '@yanbot-harness/' + name,
      version,
      file,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  await writeFile(
    path.join(commonRoot, 'common-manifest.json'),
    JSON.stringify({ version, sourceCommit, sourceLockSha256, artifacts }),
  );
  const { createHash, generateKeyPairSync } = await import('node:crypto');
  for (const target of [
    { name: 'darwin-arm64', os: 'darwin', cpu: 'arm64' },
    { name: 'win32-x64', os: 'win32', cpu: 'x64' },
  ]) {
    const platformRoot = path.join(fixture, 'platform-' + target.name);
    const outputRoot = path.join(fixture, 'output-' + target.name);
    await mkdir(platformRoot);
    const platformFile = 'runtime-' + target.name + '.tgz';
    const platformBytes = Buffer.from('platform-' + target.name);
    await writeFile(path.join(platformRoot, platformFile), platformBytes);
    const publicKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
    await writeFile(path.join(platformRoot, 'test-trust.json'), JSON.stringify({ fixture: publicKey }));
    await writeFile(
      path.join(platformRoot, 'build-report.json'),
      JSON.stringify({
        status: 'passed',
        version,
        sourceCommit,
        sourceLockSha256,
        target: { os: target.os, cpu: target.cpu, libc: null },
        testSigning: true,
        publishAuthorized: false,
        manifest: { packageName: '@yanbot-harness/runtime-' + target.name },
        artifact: {
          file: platformFile,
          size: platformBytes.length,
          sha256: createHash('sha256').update(platformBytes).digest('hex'),
        },
      }),
    );
    const arguments_ = [
      path.join(import.meta.dirname, 'build-internal-delivery.mjs'),
      '--common',
      commonRoot,
      '--platform',
      platformRoot,
      '--output-dir',
      outputRoot,
    ];
    const result = JSON.parse((await execute(process.execPath, arguments_, { timeout: 30000 })).stdout);
    assert.equal(result.target, target.name);
    assert.equal(result.rootPackage, '@yanbot-harness/local');
    assert.equal(result.productionAuthorized, false);
    const extract = path.join(fixture, '含 空格 extract-' + target.name);
    await mkdir(extract);
    await extractRuntimeArchive(result.archive, extract);
    const root = path.join(extract, result.name);
    await verifyChecksums(root);
    const manifest = JSON.parse(await readFile(path.join(root, 'delivery-manifest.json'), 'utf8'));
    assert.equal(manifest.target, target.name);
    assert.equal(manifest.rootPackage, '@yanbot-harness/local');
    assert.equal(manifest.offlineKit.packageCount, 6);
    await assert.rejects(execute(process.execPath, arguments_), /already exists/u);
  }
});
