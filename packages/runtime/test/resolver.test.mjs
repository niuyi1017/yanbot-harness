import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, open, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Buffer } from 'node:buffer';

import { buildPlatformPackage } from '../../../scripts/lib/build-platform-package.mjs';
import { resolvePlatformDirectory, currentTarget } from '../lib/index.mjs';
import { manifestBytes, validateManifest, verifyPlatformPackage, VERSION } from '../lib/manifest.mjs';
import { privateDirectory } from '../lib/permissions.mjs';

async function fixture(t, version = VERSION) {
  const root = await mkdtemp(path.join(tmpdir(), 'runtime-resolver-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  await mkdir(path.join(source, 'dist'), { recursive: true });
  const adapter = path.join(source, 'node_modules/@yanbot-harness/adapter-reference');
  await mkdir(adapter, { recursive: true });
  await writeFile(
    path.join(source, 'package.json'),
    JSON.stringify({
      name: '@yanbot-harness/local-runtime',
      version,
      dependencies: { '@yanbot-harness/adapter-reference': '0.1.0' },
    }),
  );
  await writeFile(
    path.join(adapter, 'package.json'),
    JSON.stringify({ name: '@yanbot-harness/adapter-reference', version: '0.1.0', license: 'MIT' }),
  );
  await writeFile(path.join(source, 'LICENSE'), 'Fixture license');
  await writeFile(path.join(source, 'dist/main.js'), 'process.exit(0);\n');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const directory = path.join(root, 'platform');
  const target = currentTarget();
  const keyId = 'ephemeral-test';
  const manifest = await buildPlatformPackage({
    source,
    destination: directory,
    release: { version, sourceCommit: 'a'.repeat(40), sourceLockSha256: 'b'.repeat(64) },
    target,
    keyId,
    privateKey,
  });
  const trustedKeys = { [keyId]: publicKey.export({ type: 'spki', format: 'pem' }) };
  const options = {
    directory,
    target,
    expectedVersion: version,
    trustedKeys,
    cacheRoot: path.join(root, '缓存 space &'),
  };
  return { root, source, directory, manifest, privateKey, options };
}

test('private directory normalization succeeds before any payload is opened', async (t) => {
  const f = await fixture(t);
  await privateDirectory(f.options.cacheRoot, globalThis.AbortSignal.timeout(10000));
  await privateDirectory(f.options.cacheRoot, globalThis.AbortSignal.timeout(10000));
});

test('signed package resolves in a private relocated cache; concurrent starts reuse verified bytes', async (t) => {
  const f = await fixture(t);
  const [a, b] = await Promise.all([resolvePlatformDirectory(f.options), resolvePlatformDirectory(f.options)]);
  assert.deepEqual(a, b);
  assert.equal(await readFile(a.entryPath, 'utf8'), 'process.exit(0);\n');
  assert.equal(a.runtimeVersion, VERSION);
  const c = await resolvePlatformDirectory(f.options);
  assert.deepEqual(c, a);
});

test('default trust rejects ephemeral keys, unknown keys and bad signature', async (t) => {
  const f = await fixture(t);
  await assert.rejects(resolvePlatformDirectory({ ...f.options, trustedKeys: {} }), { reason: 'INTEGRITY_FAILED' });
  await writeFile(path.join(f.directory, 'runtime-manifest.sig'), Buffer.alloc(64));
  await assert.rejects(resolvePlatformDirectory(f.options), { reason: 'INTEGRITY_FAILED' });
});

test('strict manifest rejects duplicate/unknown keys, ordering, wrong Node and incompatible version', async (t) => {
  const f = await fixture(t);
  const original = manifestBytes(f.manifest);
  for (const bytes of [
    Buffer.from(original.toString().replace('"schemaVersion": 1,', '"schemaVersion": 1, "schemaVersion": 1,')),
    manifestBytes({ ...f.manifest, extra: true }),
    manifestBytes({ ...f.manifest, nodeRange: '>=18' }),
    Buffer.concat([Buffer.from([239, 187, 191]), original]),
  ])
    assert.throws(() => validateManifest(bytes));
  await assert.rejects(
    verifyPlatformPackage({ ...f.options, expectedVersion: '0.1.0-preview.4' }),
    /version mismatch/u,
  );
});

test('tampered materials or compressed payload fail even with populated cache', async (t) => {
  const f = await fixture(t);
  await resolvePlatformDirectory(f.options);
  const file = path.join(f.directory, 'LICENSE');
  const original = await readFile(file);
  await writeFile(file, 'tampered');
  await assert.rejects(resolvePlatformDirectory(f.options), { reason: 'INTEGRITY_FAILED' });
  await writeFile(file, original);
  await writeFile(path.join(f.directory, 'payload/runtime.tar.gz'), 'bad payload');
  await assert.rejects(resolvePlatformDirectory(f.options), { reason: 'INTEGRITY_FAILED' });
});

test('cache corruption is never executed, overwritten or deleted', async (t) => {
  const f = await fixture(t);
  const first = await resolvePlatformDirectory(f.options);
  await writeFile(first.entryPath, 'user-modified');
  await assert.rejects(resolvePlatformDirectory(f.options), { reason: 'CACHE_UNAVAILABLE' });
  assert.equal(await readFile(first.entryPath, 'utf8'), 'user-modified');
});

test('symlink cache ancestry is rejected and unrelated state survives', async (t) => {
  const f = await fixture(t);
  const elsewhere = path.join(f.root, 'elsewhere');
  await mkdir(elsewhere);
  const link = path.join(f.root, 'link');
  await symlink(elsewhere, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(resolvePlatformDirectory({ ...f.options, cacheRoot: path.join(link, 'cache') }), {
    reason: 'CACHE_UNAVAILABLE',
  });
});

test('pre-cancelled resolution cannot publish cache or spawn', async (t) => {
  const f = await fixture(t);
  const signal = globalThis.AbortSignal.abort(new Error('cancel fixture'));
  await assert.rejects(resolvePlatformDirectory({ ...f.options, signal }), /cancel fixture/u);
});

test('a correctly re-signed wrong version is rejected', async (t) => {
  const f = await fixture(t);
  const modified = { ...f.manifest, version: '0.1.0-preview.99', sdkVersion: '0.1.0-preview.99' };
  const bytes = manifestBytes(modified);
  await writeFile(path.join(f.directory, 'runtime-manifest.json'), bytes);
  await writeFile(path.join(f.directory, 'runtime-manifest.sig'), sign(null, bytes, f.privateKey));
  await assert.rejects(resolvePlatformDirectory(f.options), { reason: 'INTEGRITY_FAILED' });
});

test('versioned cache V1 to V2 to V1 preserves an open V1 file and caller state', async (t) => {
  const a = await fixture(t);
  const b = await fixture(t, '0.1.0-preview.4');
  const original = await resolvePlatformDirectory(a.options);
  const held = await open(original.entryPath, 'r');
  t.after(() => held.close());
  const sentinel = path.join(a.root, 'user-configuration');
  await writeFile(sentinel, 'preserved');
  const next = await resolvePlatformDirectory({ ...b.options, cacheRoot: a.options.cacheRoot });
  assert.notEqual(next.entryPath, original.entryPath);
  assert.equal(next.runtimeVersion, '0.1.0-preview.4');
  assert.deepEqual(await resolvePlatformDirectory(a.options), original);
  assert.equal(await held.readFile('utf8'), 'process.exit(0);\n');
  assert.equal(await readFile(sentinel, 'utf8'), 'preserved');
});

test('kernel lock wait respects cancellation and recovers when its owning process dies', async (t) => {
  const f = await fixture(t);
  const resolved = await resolvePlatformDirectory(f.options);
  const identity = await realpath(path.resolve(resolved.entryPath, '../..'));
  const digest = createHash('sha256').update(identity).digest('hex');
  const port = 35000 + (Number.parseInt(digest.slice(0, 8), 16) % 25000);
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { createServer } from 'node:net'; createServer(s=>s.destroy()).listen({host:'127.0.0.1', port:${port}, exclusive:true},()=>process.send('locked'));`,
    ],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
  );
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
  });
  await once(child, 'message', { signal: globalThis.AbortSignal.timeout(10000) });
  await assert.rejects(resolvePlatformDirectory({ ...f.options, signal: globalThis.AbortSignal.timeout(1000) }), {
    name: 'TimeoutError',
  });
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  assert.deepEqual(await resolvePlatformDirectory(f.options), resolved);
});

test('trust rotation accepts only explicitly active keys and revocation also rejects a populated cache', async (t) => {
  const f = await fixture(t);
  await resolvePlatformDirectory(f.options);
  const next = generateKeyPairSync('ed25519');
  const oldKeys = f.options.trustedKeys;
  const newKeys = { rotated: next.publicKey.export({ type: 'spki', format: 'pem' }) };
  const bytes = manifestBytes({ ...f.manifest, keyId: 'rotated' });
  await writeFile(path.join(f.directory, 'runtime-manifest.json'), bytes);
  await writeFile(path.join(f.directory, 'runtime-manifest.sig'), sign(null, bytes, next.privateKey));
  await assert.rejects(resolvePlatformDirectory(f.options), { reason: 'INTEGRITY_FAILED' });
  await resolvePlatformDirectory({ ...f.options, trustedKeys: { ...oldKeys, ...newKeys } });
  await resolvePlatformDirectory({ ...f.options, trustedKeys: newKeys });
  await assert.rejects(resolvePlatformDirectory({ ...f.options, trustedKeys: {} }), { reason: 'INTEGRITY_FAILED' });
});

test('an occupied cache parent fails without changing an older cache or the blocking file', async (t) => {
  const f = await fixture(t);
  const old = await resolvePlatformDirectory(f.options);
  const blocked = path.join(f.root, 'occupied');
  await writeFile(blocked, 'keep occupied file');
  await assert.rejects(resolvePlatformDirectory({ ...f.options, cacheRoot: path.join(blocked, 'cache') }), {
    reason: 'CACHE_UNAVAILABLE',
  });
  assert.equal(await readFile(blocked, 'utf8'), 'keep occupied file');
  assert.deepEqual(await resolvePlatformDirectory(f.options), old);
});
