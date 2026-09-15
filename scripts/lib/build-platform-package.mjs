import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createPublicKey, sign } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { packRuntimeArchive, sha256 } from '../../packages/runtime/lib/archive.mjs';
import {
  manifestBytes,
  NODE_RANGE,
  validateManifest,
  verifyPlatformPackage,
} from '../../packages/runtime/lib/manifest.mjs';
import { auditDeployedPackages } from './deploy-probe-audit.mjs';

// Destination must be new. Caller owns release identity and signing authority.
export async function buildPlatformPackage({ source, destination, release, target, privateKey, keyId, signal }) {
  assert(privateKey.asymmetricKeyType === 'ed25519', 'Only Ed25519 signing keys are supported.');
  const root = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
  assert.equal(root.version, release.version, 'Payload release version mismatch.');
  await mkdir(destination, { mode: 0o700 });
  const packed = await packRuntimeArchive({ source, outputDirectory: path.join(destination, 'payload'), signal });
  await copyFile(path.join(destination, 'payload/files.json'), path.join(destination, 'files.json'));
  // The codec emits files.json alongside the archive for probes; exclude that extra copy from npm files.
  const name = '@yanbot-harness/runtime-' + target.os + '-' + target.cpu;
  const graph = await auditDeployedPackages(source);
  const components = [];
  const adapters = [];
  async function walk(current) {
    const relative = path.relative(source, current).split(path.sep).join('/');
    if (!relative || /(?:^|\/)node_modules\/(?:@[^/]+\/)?[^@/][^/]*$/u.test(relative)) {
      const pkg = JSON.parse(await readFile(path.join(current, 'package.json'), 'utf8'));
      const licenses = [];
      for (const file of await readdir(current, { withFileTypes: true })) {
        if (file.isFile() && /^(?:licen[sc]e|copying|notice)(?:[.-]|$)/iu.test(file.name)) {
          const content = await readFile(path.join(current, file.name));
          licenses.push({ path: path.posix.join(relative, file.name), size: content.length, sha256: sha256(content) });
        }
      }
      components.push({
        name: pkg.name,
        version: pkg.version,
        location: relative || '.',
        license: pkg.license ?? 'NOASSERTION',
        licenses,
      });
      if (pkg.name === '@yanbot-harness/adapter-reference')
        adapters.push({ adapterId: 'cn.yanbot.reference', packageName: pkg.name, version: pkg.version });
      if (pkg.name === '@yanbot-harness/adapter-codebuddy')
        adapters.push({ adapterId: 'cn.yanbot.codebuddy', packageName: pkg.name, version: pkg.version });
    }
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== '.bin') await walk(path.join(current, entry.name));
    }
  }
  await walk(source);
  components.sort((a, b) => (a.location < b.location ? -1 : a.location > b.location ? 1 : 0));
  adapters.sort((a, b) => (a.adapterId < b.adapterId ? -1 : a.adapterId > b.adapterId ? 1 : 0));
  const notices =
    'License inventory only; not a redistribution approval. Original license texts remain inside the payload.\n' +
    components
      .map(
        (item) =>
          item.name +
          '@' +
          item.version +
          ': ' +
          JSON.stringify(item.license) +
          ' [' +
          item.licenses.map((l) => l.path).join(', ') +
          ']',
      )
      .join('\n') +
    '\n';
  const bodies = [
    ['LICENSE', await readFile(path.join(source, 'LICENSE'))],
    ['THIRD_PARTY_NOTICES', Buffer.from(notices)],
    [
      'sbom.json',
      manifestBytes({
        schemaVersion: 1,
        kind: 'yanbot-runtime-inventory',
        sourceCommit: release.sourceCommit,
        sourceLockSha256: release.sourceLockSha256,
        components,
        graph,
      }),
    ],
  ];
  const materials = [];
  for (const [file, content] of bodies) {
    assert(content.length <= 8 * 1024 * 1024, 'Material size limit.');
    await writeFile(path.join(destination, file), content, { flag: 'wx' });
    materials.push({ path: file, size: content.length, sha256: sha256(content) });
  }
  const manifest = {
    schemaVersion: 1,
    packageName: name,
    version: release.version,
    sourceCommit: release.sourceCommit,
    sourceLockSha256: release.sourceLockSha256,
    target,
    nodeRange: NODE_RANGE,
    protocolVersion: '1.0.0',
    managedProtocolVersion: 1,
    sdkVersion: release.version,
    entryPath: 'dist/main.js',
    payload: { path: 'payload/runtime.tar.gz', ...packed.payload },
    fileList: { path: 'files.json', ...packed.fileList },
    materials,
    adapters,
    keyId,
  };
  const bytes = manifestBytes(manifest);
  validateManifest(bytes);
  await writeFile(path.join(destination, 'runtime-manifest.json'), bytes, { flag: 'wx' });
  await writeFile(path.join(destination, 'runtime-manifest.sig'), sign(null, bytes, privateKey), { flag: 'wx' });
  await writeFile(
    path.join(destination, 'package.json'),
    manifestBytes({
      name,
      version: release.version,
      license: 'UNLICENSED',
      os: [target.os],
      cpu: [target.cpu],
      ...(target.libc ? { libc: [target.libc] } : {}),
      files: [
        'runtime-manifest.json',
        'runtime-manifest.sig',
        'files.json',
        'payload/runtime.tar.gz',
        'LICENSE',
        'THIRD_PARTY_NOTICES',
        'sbom.json',
      ],
      exports: { './manifest': './runtime-manifest.json' },
      publishConfig: { access: 'restricted', registry: 'https://registry.example.invalid' },
    }),
    { flag: 'wx' },
  );
  await verifyPlatformPackage({
    directory: destination,
    target,
    expectedVersion: release.version,
    trustedKeys: { [keyId]: createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }) },
    signal,
  });
  return manifest;
}
