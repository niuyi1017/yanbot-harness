import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { generateKeyPairSync, sign } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { sha256 } from '../packages/runtime/lib/archive.mjs';
import { manifestBytes } from '../packages/runtime/lib/manifest.mjs';
import { installOfflineKit } from './templates/install-local.mjs';
import { normalizeWindowsBinShims } from './lib/windows-bin-shims.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'offline-integrity-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'packages'));
  const installer = await readFile(path.join(import.meta.dirname, 'templates/install-local.mjs'));
  await writeFile(path.join(root, 'install-local.mjs'), installer);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const trustedKeys = { fixture: publicKey.export({ type: 'spki', format: 'pem' }) };
  const target = process.platform + '-' + process.arch;
  const artifacts = [];
  for (const name of ['local', 'sdk', 'contracts', 'runtime', 'runtime-' + target]) {
    const content = Buffer.from('fixture; not a real tarball');
    const file = name + '.tgz';
    await writeFile(path.join(root, 'packages', file), content);
    artifacts.push({
      name: '@yanbot-harness/' + name,
      version: '0.1.0-preview.3',
      file,
      size: content.length,
      sha256: sha256(content),
    });
  }
  const manifest = {
    schemaVersion: 1,
    version: '0.1.0-preview.3',
    sourceCommit: 'a'.repeat(40),
    sourceLockSha256: 'b'.repeat(64),
    target,
    keyId: 'fixture',
    testSigning: true,
    installer: { file: 'install-local.mjs', size: installer.length, sha256: sha256(installer) },
    artifacts,
  };
  const save = async () => {
    const bytes = manifestBytes(manifest);
    await writeFile(path.join(root, 'kit-manifest.json'), bytes);
    await writeFile(path.join(root, 'kit-manifest.sig'), sign(null, bytes, privateKey));
  };
  await save();
  const prefix = path.join(root, 'new-consumer');
  return {
    root,
    prefix,
    manifest,
    save,
    install: (keys = trustedKeys) => installOfflineKit({ kitDirectory: root, prefix, trustedKeys: keys }),
  };
}

test('offline unknown signer and tampered tgz fail before creating a consumer', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.install({}), /Unknown kit signer/u);
  await writeFile(path.join(f.root, 'packages/local.tgz'), 'tampered');
  await assert.rejects(f.install(), /digest|changed/u);
  await assert.rejects(stat(f.prefix), { code: 'ENOENT' });
});
test('standalone installer executes its CLI guard even through temporary path aliases', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    promisify(execFile)(process.execPath, [path.join(f.root, 'install-local.mjs'), '--invalid']),
    (error) => error.stderr.includes('Use node install-local.mjs'),
  );
});
test('offline target mismatch and signed path escape fail before installation', async (t) => {
  const f = await fixture(t);
  f.manifest.target = 'unsupported';
  await f.save();
  await assert.rejects(f.install(), /target mismatch/u);
  f.manifest.target = process.platform + '-' + process.arch;
  f.manifest.artifacts[0].file = '../outside.tgz';
  await f.save();
  await assert.rejects(f.install());
  await assert.rejects(stat(f.prefix), { code: 'ENOENT' });
});
test('offline duplicate package fails before consumer creation', async (t) => {
  const f = await fixture(t);
  f.manifest.artifacts[1].name = f.manifest.artifacts[0].name;
  await f.save();
  await assert.rejects(f.install(), /Duplicate package/u);
  await assert.rejects(stat(f.prefix), { code: 'ENOENT' });
});
test('offline missing closure fails independently of duplicate detection', async (t) => {
  const f = await fixture(t);
  f.manifest.artifacts.at(-1).name = 'a-benign-third-party-fixture';
  await f.save();
  await assert.rejects(f.install(), /closure missing required package/u);
  await assert.rejects(stat(f.prefix), { code: 'ENOENT' });
});
test('offline oversized signed artifact fails without reading or writing its bytes', async (t) => {
  const f = await fixture(t);
  f.manifest.artifacts[0].size = 128 * 1024 * 1024 + 1;
  await f.save();
  await assert.rejects(f.install());
  await assert.rejects(stat(f.prefix), { code: 'ENOENT' });
});
test('offline installer tampering and package path aliasing are rejected', async (t) => {
  const f = await fixture(t);
  const installer = path.join(f.root, 'install-local.mjs');
  const original = await readFile(installer);
  await writeFile(installer, 'tampered bootstrap');
  await assert.rejects(f.install(), /digest|changed/u);
  await writeFile(installer, original);
  f.manifest.artifacts[1].file = f.manifest.artifacts[0].file;
  await f.save();
  await assert.rejects(f.install());
  await assert.rejects(stat(f.prefix), { code: 'ENOENT' });
});
test('existing consumer is never overwritten even by a valid signed kit', async (t) => {
  const f = await fixture(t);
  await mkdir(f.prefix);
  await writeFile(path.join(f.prefix, 'sentinel'), 'keep');
  await assert.rejects(f.install(), { code: 'EEXIST' });
  assert.equal(await readFile(path.join(f.prefix, 'sentinel'), 'utf8'), 'keep');
});
test('Windows shims use only validated relative Node targets and reject unknown entries', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'windows-shim-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bins = path.join(root, 'node_modules/.bin');
  await mkdir(bins, { recursive: true });
  for (const [name, entry] of [
    ['uuidv7', 'cli.js'],
    ['which', 'bin/which'],
  ]) {
    const directory = path.join(root, 'node_modules', name);
    await mkdir(path.dirname(path.join(directory, entry)), { recursive: true });
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name, bin: { [name]: './' + entry } }));
    await writeFile(path.join(directory, entry), '#!/usr/bin/env node\n');
    for (const suffix of ['', '.CMD', '.ps1'])
      await writeFile(path.join(bins, name + suffix), 'old absolute build path');
  }
  const result = await normalizeWindowsBinShims(root);
  assert.equal(result.length, 6);
  assert((await readFile(path.join(bins, 'uuidv7.CMD'), 'utf8')).includes('%~dp0..'));
  assert((await readFile(path.join(bins, 'which.ps1'), 'utf8')).includes('$PSScriptRoot/../which/bin/which'));
  for (const item of result) assert(!(await readFile(path.join(root, item.path), 'utf8')).includes('old absolute'));
  await writeFile(path.join(bins, 'unknown.cmd'), 'do not remove');
  await assert.rejects(normalizeWindowsBinShims(root), /Unreviewed/u);
});
