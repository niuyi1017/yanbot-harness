import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
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

test(
  'Windows exclusive file sharing blocks cache use without replacement and recovers after release',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const f = await fixture(t);
    const old = await resolvePlatformDirectory(f.options);
    const script = `$ErrorActionPreference='Stop'; $h=[System.IO.File]::Open('${old.entryPath.replaceAll("'", "''")}', 'Open', 'Read', 'None'); [Console]::WriteLine('locked'); [Console]::ReadLine() | Out-Null; $h.Dispose()`;
    const child = spawn(
      path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true },
    );
    const exited = once(child, 'exit');
    try {
      await once(child.stdout, 'data', { signal: globalThis.AbortSignal.timeout(15000) });
      await assert.rejects(resolvePlatformDirectory(f.options), { reason: 'CACHE_UNAVAILABLE' });
    } finally {
      child.stdin.end('\n');
      const timer = globalThis.setTimeout(() => child.kill('SIGKILL'), 5000);
      try {
        await exited;
      } finally {
        globalThis.clearTimeout(timer);
      }
    }
    assert.deepEqual(await resolvePlatformDirectory(f.options), old);
    assert.equal(await readFile(old.entryPath, 'utf8'), 'process.exit(0);\n');
  },
);

test('signed package resolves in a private relocated cache; concurrent starts reuse verified bytes', async (t) => {
  const f = await fixture(t);
  const [a, b] = await Promise.all([resolvePlatformDirectory(f.options), resolvePlatformDirectory(f.options)]);
  assert.deepEqual(a, b);
  assert.equal(await readFile(a.entryPath, 'utf8'), 'process.exit(0);\n');
  assert.equal(a.runtimeVersion, VERSION);
  const c = await resolvePlatformDirectory(f.options);
  assert.deepEqual(c, a);
});

test('VM resolver binds each guest artifact to the signed file inventory before returning paths', async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.source, 'native/guest'), { recursive: true });
  await writeFile(path.join(f.source, 'native/managed-vm-host'), 'inert host fixture');
  const containment = { kind: 'macos-vm-v1', entryPath: 'native/managed-vm-host', guestTarget: 'linux-arm64' };
  for (const name of ['kernel', 'initrd']) {
    const bytes = Buffer.from('inert ' + name);
    await writeFile(path.join(f.source, 'native/guest', name), bytes);
    containment[name] = { path: 'native/guest/' + name, sha256: createHash('sha256').update(bytes).digest('hex') };
  }
  const directory = path.join(f.root, 'vm-platform');
  const target = { os: 'darwin', cpu: 'arm64', libc: null };
  const manifest = await buildPlatformPackage({
    source: f.source,
    destination: directory,
    release: { version: VERSION, sourceCommit: 'a'.repeat(40), sourceLockSha256: 'b'.repeat(64) },
    target,
    privateKey: f.privateKey,
    keyId: f.manifest.keyId,
    containment,
  });
  const options = { ...f.options, directory, target };
  const resolved = await resolvePlatformDirectory(options);
  assert.equal(resolved.containment.kind, 'macos-vm-v1');
  assert.equal(await readFile(resolved.containment.kernel.path, 'utf8'), 'inert kernel');
  assert.equal(resolved.containment.initrd.sha256, containment.initrd.sha256);
  const invalid = { ...manifest, containment: { ...containment, guestTarget: 'darwin-arm64' } };
  assert.throws(() => validateManifest(manifestBytes(invalid)));
  manifest.containment.kernel.sha256 = 'c'.repeat(64);
  const changed = manifestBytes(manifest);
  await writeFile(path.join(directory, 'runtime-manifest.json'), changed);
  await writeFile(path.join(directory, 'runtime-manifest.sig'), sign(null, changed, f.privateKey));
  await assert.rejects(resolvePlatformDirectory(options), { reason: 'INTEGRITY_FAILED' });
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

test(
  'read-only installed platform contents resolve without any installation-directory writes',
  { skip: process.platform === 'win32' },
  async (t) => {
    const f = await fixture(t);
    const entries = await readdir(f.directory, { recursive: true, withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name));
    const directories = [
      f.directory,
      ...entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(entry.parentPath, entry.name)),
    ];
    for (const file of files) await chmod(file, 0o400);
    for (const directory of directories) await chmod(directory, 0o500);
    try {
      const runtime = await resolvePlatformDirectory(f.options);
      assert.equal(await readFile(runtime.entryPath, 'utf8'), 'process.exit(0);\n');
    } finally {
      for (const directory of directories) await chmod(directory, 0o700);
      for (const file of files) await chmod(file, 0o600);
    }
  },
);
