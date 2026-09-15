import assert from 'node:assert/strict';
import { Buffer, isUtf8 } from 'node:buffer';
import { createPublicKey, verify } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

import { ARCHIVE_LIMITS, sha256, validateFileList } from './archive.mjs';

export const VERSION = '0.1.0-preview.3';
export const NODE_RANGE = '>=22.22.0 <23';
export const TARGETS = Object.freeze({
  'darwin-arm64': { os: 'darwin', cpu: 'arm64', libc: null },
  'win32-x64': { os: 'win32', cpu: 'x64', libc: null },
  'linux-x64': { os: 'linux', cpu: 'x64', libc: 'glibc' },
});
export const TRUSTED_KEYS = Object.freeze({});
export const manifestBytes = (value) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const digest = /^[a-f0-9]{64}$/u;
const version = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

function keys(value, names) {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'Invalid object.');
  assert.deepEqual(Object.keys(value), names.split(' '), 'Unexpected fields or order.');
}
function size(value, maximum) {
  assert(Number.isSafeInteger(value) && value >= 0 && value <= maximum, 'Size limit.');
}
function material(value, file, maximum, count = false) {
  keys(value, count ? 'path size sha256 entryCount' : 'path size sha256');
  assert.equal(value.path, file, 'Unexpected material path.');
  size(value.size, maximum);
  assert(digest.test(value.sha256), 'Invalid digest.');
  if (count) size(value.entryCount, ARCHIVE_LIMITS.entries);
}

export function validateManifest(bytes) {
  assert(Buffer.isBuffer(bytes) && bytes.length <= 65536 && isUtf8(bytes), 'Manifest encoding/limit.');
  const m = JSON.parse(bytes.toString('utf8'));
  keys(
    m,
    'schemaVersion packageName version sourceCommit sourceLockSha256 target nodeRange protocolVersion managedProtocolVersion sdkVersion entryPath payload fileList materials adapters keyId' +
      (Object.hasOwn(m, 'containment') ? ' containment' : ''),
  );
  assert.equal(m.schemaVersion, 1);
  assert(version.test(m.version) && m.sdkVersion === m.version, 'Invalid release version.');
  assert(/^[a-f0-9]{40}$/u.test(m.sourceCommit) && digest.test(m.sourceLockSha256), 'Invalid source identity.');
  keys(m.target, 'os cpu libc');
  const target = TARGETS[m.target.os + '-' + m.target.cpu];
  assert(target, 'Unsupported target.');
  assert.deepEqual(m.target, target);
  assert.equal(m.packageName, '@yanbot-harness/runtime-' + m.target.os + '-' + m.target.cpu);
  assert.equal(m.nodeRange, NODE_RANGE);
  assert.equal(m.protocolVersion, '1.0.0');
  assert.equal(m.managedProtocolVersion, 1);
  assert.equal(m.entryPath, 'dist/main.js');
  if (m.containment) {
    if (m.containment.kind === 'macos-vm-v1') {
      keys(m.containment, 'kind entryPath guestTarget kernel initrd');
      assert.equal(m.target.os, 'darwin');
      assert.equal(m.containment.entryPath, 'native/managed-vm-host');
      assert.equal(m.containment.guestTarget, 'linux-arm64');
      for (const name of ['kernel', 'initrd']) {
        keys(m.containment[name], 'path sha256');
        assert.equal(m.containment[name].path, 'native/guest/' + name);
        assert(digest.test(m.containment[name].sha256));
      }
    } else {
      keys(m.containment, 'kind entryPath');
      assert.equal(m.target.os, 'win32');
      assert.equal(m.containment.kind, 'windows-job-v1');
      assert.equal(m.containment.entryPath, 'native/managed-job-host.exe');
    }
  } else assert(!Object.hasOwn(m, 'containment'), 'Invalid containment descriptor.');
  material(m.payload, 'payload/runtime.tar.gz', ARCHIVE_LIMITS.compressedBytes);
  assert(m.payload.size >= 18);
  material(m.fileList, 'files.json', ARCHIVE_LIMITS.fileListBytes, true);
  assert(Array.isArray(m.materials) && m.materials.length === 3, 'Missing materials.');
  ['LICENSE', 'THIRD_PARTY_NOTICES', 'sbom.json'].forEach((file, index) =>
    material(m.materials[index], file, 8 * 1024 * 1024),
  );
  assert(Array.isArray(m.adapters) && m.adapters.length > 0 && m.adapters.length <= 100);
  let previous = '';
  for (const adapter of m.adapters) {
    keys(adapter, 'adapterId packageName version');
    assert(
      typeof adapter.adapterId === 'string' &&
        /^[A-Za-z0-9.-]+$/u.test(adapter.adapterId) &&
        adapter.adapterId > previous,
    );
    assert(/^@yanbot-harness\/adapter-[a-z0-9-]+$/u.test(adapter.packageName));
    assert(version.test(adapter.version));
    previous = adapter.adapterId;
  }
  assert(typeof m.keyId === 'string' && /^[A-Za-z0-9._-]{1,80}$/u.test(m.keyId));
  assert(bytes.equals(manifestBytes(m)), 'Noncanonical manifest.');
  return m;
}

// Size is enforced while reading too, not just by a raceable stat before readFile.
export async function readBounded(file, limit, signal) {
  signal?.throwIfAborted();
  assert((await lstat(file)).isFile(), 'Material must not be a link.');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    assert(info.isFile() && info.size <= limit, 'Material must be a bounded regular file.');
    const result = Buffer.alloc(Math.min(limit + 1, info.size + 1));
    let offset = 0;
    while (offset < result.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(result, offset, result.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    assert(offset === info.size && offset <= limit, 'Material changed during read.');
    return result.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

export async function verifyPlatformPackage({
  directory,
  target,
  expectedVersion = VERSION,
  trustedKeys = TRUSTED_KEYS,
  signal,
}) {
  const bytes = await readBounded(path.join(directory, 'runtime-manifest.json'), 65536, signal);
  const m = validateManifest(bytes);
  assert((await lstat(path.join(directory, 'payload'))).isDirectory(), 'Payload directory must not be a link.');
  assert(Object.hasOwn(trustedKeys, m.keyId), 'Unknown signing key. Configure an authorized release trust root.');
  const signature = await readBounded(path.join(directory, 'runtime-manifest.sig'), 64, signal);
  const key = createPublicKey(trustedKeys[m.keyId]);
  assert(key.asymmetricKeyType === 'ed25519', 'Signing key must be Ed25519.');
  assert(signature.length === 64 && verify(null, bytes, key, signature), 'Invalid manifest signature.');
  assert.equal(m.version, expectedVersion, 'Runtime version mismatch.');
  assert.deepEqual(m.target, target, 'Runtime target mismatch.');
  const pkg = JSON.parse((await readBounded(path.join(directory, 'package.json'), 65536, signal)).toString('utf8'));
  assert.equal(pkg.name, m.packageName);
  assert.equal(pkg.version, m.version);
  assert.deepEqual(pkg.os, [target.os]);
  assert.deepEqual(pkg.cpu, [target.cpu]);
  assert.deepEqual(pkg.libc, target.libc ? [target.libc] : undefined);
  assert.deepEqual(pkg.exports, { './manifest': './runtime-manifest.json' });
  assert(
    !pkg.scripts && !pkg.dependencies && !pkg.optionalDependencies && !pkg.peerDependencies,
    'Platform package must contain data only.',
  );
  for (const item of m.materials) {
    const content = await readBounded(path.join(directory, item.path), item.size, signal);
    assert(content.length === item.size && sha256(content) === item.sha256, 'Material digest mismatch.');
  }
  const fileListBytes = await readBounded(path.join(directory, 'files.json'), m.fileList.size, signal);
  const entries = validateFileList(fileListBytes, m.fileList);
  if (m.containment)
    assert(
      entries.some((entry) => entry.path === m.containment.entryPath && entry.type === 'file'),
      'Missing containment host.',
    );
  if (m.containment?.kind === 'macos-vm-v1')
    for (const name of ['kernel', 'initrd'])
      assert(
        entries.some(
          (entry) =>
            entry.path === m.containment[name].path &&
            entry.type === 'file' &&
            entry.sha256 === m.containment[name].sha256,
        ),
        'Missing or unbound guest artifact.',
      );
  assert(
    entries.some((entry) => entry.path === m.entryPath && entry.type === 'file'),
    'Missing Runtime entry.',
  );
  return { manifest: m, entries, fileListBytes };
}
