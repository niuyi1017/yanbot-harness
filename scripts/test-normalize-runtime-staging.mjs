import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { auditDeployedPackages } from './lib/deploy-probe-audit.mjs';
import {
  inspectCandidate,
  NORMALIZATION_METADATA,
  normalizeRuntimeStaging,
  validateCandidatePath,
} from './lib/normalize-runtime-staging.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'harness-normalize-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  await mkdir(source);
  const ownedPackages = [
    { name: '@probe/runtime', version: '1.0.0-preview.1' },
    { name: '@probe/core', version: '1.2.0' },
  ];
  async function put(relative, content) {
    const file = path.join(source, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, typeof content === 'object' && !Buffer.isBuffer(content) ? JSON.stringify(content) : content);
  }
  await put('package.json', {
    ...ownedPackages[0],
    type: 'module',
    exports: './main.js',
    dependencies: { '@probe/core': 'workspace:*', vendor: '^2.0.0' },
    devDependencies: { fake: 'file:/build/private/project' },
    scripts: { prepare: 'do-not-run' },
    packageManager: 'pnpm@11.10.0',
  });
  await put('main.js', 'export const fixture = true;\n');
  await put('node_modules/@probe/core/package.json', {
    ...ownedPackages[1],
    dependencies: { vendor: '^2.0.0' },
    license: 'MIT',
  });
  await put('node_modules/vendor/package.json', {
    name: 'vendor',
    version: '2.1.0',
    scripts: { build: 'preserve-me' },
    devDependencies: { unrelated: '^9.0.0' },
  });
  await put('node_modules/vendor/embedded/tool.bin', Buffer.from([0, 1, 255]));
  await put('node_modules/vendor/LICENSE', 'fixture license\n');
  for (const relative of NORMALIZATION_METADATA) await put(relative, '/build/private/project\n');
  return {
    root,
    source,
    ownedPackages,
    put,
    normalize: (destination = path.join(root, 'normalized')) =>
      normalizeRuntimeStaging({ source, destination, ownedPackages, forbiddenRoots: ['/build/private/project'] }),
  };
}

test('normalization pins owned dependencies, preserves vendor bytes and resolved graph, and is repeatable', async (t) => {
  const f = await fixture(t);
  const result = await f.normalize();
  assert.deepEqual(result.omitted.sort(), [...NORMALIZATION_METADATA].sort());
  assert.equal(result.manifests.length, 2);
  const output = path.join(f.root, 'normalized');
  const manifest = JSON.parse(await readFile(path.join(output, 'package.json'), 'utf8'));
  assert.deepEqual(manifest.dependencies, { '@probe/core': '1.2.0', vendor: '2.1.0' });
  assert.equal(manifest.exports, './main.js');
  assert.equal(manifest.type, 'module');
  assert(!Object.hasOwn(manifest, 'devDependencies') && !Object.hasOwn(manifest, 'scripts'));
  for (const relative of [
    'node_modules/vendor/package.json',
    'node_modules/vendor/embedded/tool.bin',
    'node_modules/vendor/LICENSE',
  ])
    assert.deepEqual(await readFile(path.join(output, relative)), await readFile(path.join(f.source, relative)));
  const options = { omitPackageManifestBytes: true, ignoredFiles: NORMALIZATION_METADATA };
  assert.deepEqual(await auditDeployedPackages(f.source, options), await auditDeployedPackages(output, options));
  assert.equal((await f.normalize(path.join(f.root, 'second'))).after.sha256, result.after.sha256);
  assert.equal(
    (
      await normalizeRuntimeStaging({
        source: output,
        destination: path.join(f.root, 'third'),
        ownedPackages: f.ownedPackages,
      })
    ).after.sha256,
    result.after.sha256,
  );
});

test('existing destination and overlapping source fail without overwriting', async (t) => {
  const f = await fixture(t);
  const output = path.join(f.root, 'normalized');
  await mkdir(output);
  await writeFile(path.join(output, 'sentinel'), 'keep');
  await assert.rejects(f.normalize(), { code: 'EEXIST' });
  assert.equal(await readFile(path.join(output, 'sentinel'), 'utf8'), 'keep');
  await assert.rejects(f.normalize(path.join(f.source, 'child')), /overlap/u);
});

test('unknown virtual-store content is not silently removed', async (t) => {
  const f = await fixture(t);
  await f.put('node_modules/.pnpm/unexpected/data.js', 'resource');
  await assert.rejects(f.normalize(), /Unexpected virtual-store/u);
});

test('owned version drift, local third-party selectors, and missing dependencies fail closed', async (t) => {
  const f = await fixture(t);
  await f.put('node_modules/@probe/core/package.json', { name: '@probe/core', version: '1.3.0' });
  await assert.rejects(f.normalize(), /version drift/u);
  await f.put('node_modules/@probe/core/package.json', {
    ...f.ownedPackages[1],
    dependencies: { vendor: 'file:/other/vendor' },
  });
  await assert.rejects(f.normalize(), /local third-party/u);
  await f.put('node_modules/@probe/core/package.json', { ...f.ownedPackages[1], dependencies: { missing: '1.0.0' } });
  await assert.rejects(f.normalize(), /dependency missing/u);
});

test('link entries and linked candidate roots are rejected', async (t) => {
  const f = await fixture(t);
  const link = path.join(f.source, 'linked');
  await symlink(f.source, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.normalize(), /Links and special/u);
  await assert.rejects(inspectCandidate(link), /real directory/u);
});

test('scans large and binary content for paths without leaking matching bytes', async (t) => {
  const f = await fixture(t);
  await f.put(
    'large.bin',
    Buffer.concat([Buffer.alloc(2 * 1024 * 1024 + 1), Buffer.from('/build/private/project', 'utf16le')]),
  );
  await assert.rejects(
    f.normalize(),
    (error) => /Build path marker: large.bin/u.test(error.message) && !error.message.includes('/build/private/project'),
  );
});

test('credential-like content and sensitive files are rejected, not redacted', async (t) => {
  const f = await fixture(t);
  const fakeToken = 'npm_' + 'x'.repeat(40);
  await f.put('node_modules/vendor/asset.js', `token=${fakeToken}`);
  await assert.rejects(
    f.normalize(),
    (error) => /Credential-like/u.test(error.message) && !error.message.includes(fakeToken),
  );
  await f.put('.env.local', 'fixture');
  await assert.rejects(inspectCandidate(f.source), /Sensitive candidate/u);
});

test('portable path validation rejects traversal, ADS, reserved names, and excessive length', () => {
  for (const relative of [
    '../a',
    '/absolute',
    'a//b',
    'a/./b',
    'C:drive',
    'a\\b',
    'a\u0000b',
    'NUL.txt',
    'dir/COM1',
    'trailing.',
    '.git/config',
    '.npmrc',
    '.env',
    'private.key',
    'x'.repeat(1025),
  ])
    assert.throws(() => validateCandidatePath(relative));
  for (const relative of ['dist/main.js', '中文 space &/asset', '.env.example', 'node_modules/vendor/LICENSE'])
    validateCandidatePath(relative);
});

test('credential scanning distinguishes TypeScript diagnostic identifiers from standalone token prefixes', async (t) => {
  const f = await fixture(t);
  await f.put('diagnostic.js', 'Block_scoped_variable_used_before_its_declaration_and_other_diagnostic_suffixes');
  await f.normalize();
  for (const [index, prefix] of ['ck_', 'npm_', 'ghp_'].entries()) {
    const token = prefix + 'a'.repeat(45);
    await f.put('diagnostic.js', Buffer.concat([Buffer.alloc(2 * 1024 * 1024 + 1), Buffer.from(`token="${token}"`)]));
    await assert.rejects(
      f.normalize(path.join(f.root, `rejected-${index}`)),
      (error) => /Credential-like/u.test(error.message) && !error.message.includes(token),
    );
  }
});

test('PEM format marker alone is not key material, while a private-key body is rejected', async (t) => {
  const f = await fixture(t);
  const header = '-----BEGIN PRIVATE KEY-----';
  await f.put('pem-parser.js', `const marker = ${JSON.stringify(header)};`);
  await f.normalize();
  await f.put('pem-parser.js', `${header}\n${'A'.repeat(80)}\n-----END PRIVATE KEY-----`);
  await assert.rejects(f.normalize(path.join(f.root, 'private-key-rejected')), /Credential-like/u);
});
