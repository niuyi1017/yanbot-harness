// T1 candidate normalization only. Never mutate a deploy source or an existing destination.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { resolveDeployedDependency } from './deploy-probe-audit.mjs';

export const NORMALIZATION_METADATA = Object.freeze([
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'node_modules/.modules.yaml',
  'node_modules/.package-map.json',
  'node_modules/.pnpm-workspace-state-v1.json',
  'node_modules/.pnpm/lock.yaml',
]);
const removedFields = [
  'devDependencies',
  'scripts',
  'packageManager',
  'pnpm',
  'publishConfig',
  '_id',
  '_from',
  '_resolved',
  '_integrity',
  '_where',
];
export const CANDIDATE_LIMITS = Object.freeze({
  entries: 100_000,
  totalBytes: 512 * 1024 * 1024,
  fileBytes: 256 * 1024 * 1024,
  pathBytes: 1024,
  fileListBytes: 2 * 1024 * 1024,
});

export async function normalizeRuntimeStaging({ source, destination, ownedPackages, forbiddenRoots = [] }) {
  assert((await lstat(source)).isDirectory(), 'Source must be a real directory.');
  const root = await realpath(source);
  const target = path.resolve(destination);
  const canonicalParent = await realpath(path.dirname(target));
  const canonicalTarget = path.join(canonicalParent, path.basename(target));
  for (const [a, b] of [
    [root, canonicalTarget],
    [canonicalTarget, root],
  ]) {
    const relative = path.relative(a, b);
    assert(
      relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative),
      'Source and destination must not overlap.',
    );
  }
  const ownership = new Map(ownedPackages.map((item) => [item.name, item.version]));
  const rootManifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(ownership.get(rootManifest.name), rootManifest.version, 'Unregistered staging root.');
  const before = await inspectCandidate(root, { scan: false });
  const plan = [];
  for (const entry of before.entries.filter((item) => item.type === 'file')) {
    if (entry.path.startsWith('node_modules/.pnpm/'))
      assert(NORMALIZATION_METADATA.includes(entry.path), 'Unexpected virtual-store content; refusing to remove it.');
    if (NORMALIZATION_METADATA.includes(entry.path)) {
      plan.push({ ...entry, action: 'omit' });
      continue;
    }
    const absolute = path.join(root, entry.path);
    let replacement;
    if (entry.path === 'package.json' || /(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+\/package\.json$/u.test(entry.path)) {
      const manifest = JSON.parse(await readFile(absolute, 'utf8'));
      if (ownership.has(manifest.name)) {
        assert.equal(manifest.version, ownership.get(manifest.name), 'Owned package version drift.');
        const normalized = { ...manifest };
        for (const field of removedFields) delete normalized[field];
        for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
          if (!manifest[field]) continue;
          normalized[field] = { ...manifest[field] };
          for (const [name, specifier] of Object.entries(manifest[field])) {
            const local = /(?:^workspace:|^file:|^link:|@file:)/u.test(specifier);
            if (local) assert(ownership.has(name), 'Unexpected local third-party dependency.');
            const resolved = await resolveDeployedDependency(root, path.dirname(absolute), name);
            if (resolved) {
              assert.equal(resolved.name, name, 'Dependency aliases require separate normalization design.');
              assert.match(resolved.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u);
              normalized[field][name] = resolved.version;
            } else {
              assert(
                !local &&
                  (field === 'optionalDependencies' ||
                    (field === 'peerDependencies' && manifest.peerDependenciesMeta?.[name]?.optional)),
                'Required normalization dependency missing.',
              );
            }
          }
        }
        replacement = Buffer.from(`${JSON.stringify(normalized, null, 2)}\n`);
      }
    }
    plan.push({ ...entry, action: replacement ? 'normalize-owned-manifest' : 'copy', replacement });
  }
  await mkdir(target); // EEXIST is a safety failure; do not reuse or clear another directory.
  for (const entry of before.entries.filter((item) => item.type === 'directory')) {
    if (entry.path === 'node_modules/.pnpm' || entry.path.startsWith('node_modules/.pnpm/')) continue;
    await mkdir(path.join(target, entry.path), { recursive: true });
  }
  for (const item of plan) {
    if (item.action === 'omit') continue;
    const output = path.join(target, item.path);
    if (item.replacement) await writeFile(output, item.replacement);
    else await copyFile(path.join(root, item.path), output);
    await chmod(output, item.executable ? 0o755 : 0o644);
  }
  const after = await inspectCandidate(target, { forbiddenRoots });
  assert.deepEqual(
    after.entries.filter((entry) => entry.type === 'directory').map((entry) => entry.path),
    before.entries
      .filter(
        (entry) =>
          entry.type === 'directory' &&
          entry.path !== 'node_modules/.pnpm' &&
          !entry.path.startsWith('node_modules/.pnpm/'),
      )
      .map((entry) => entry.path),
    'Unexpected directory change.',
  );
  const actual = new Map(after.entries.filter((entry) => entry.type === 'file').map((entry) => [entry.path, entry]));
  for (const item of plan) {
    if (item.action === 'omit') {
      assert(!actual.has(item.path));
      continue;
    }
    const output = actual.get(item.path);
    assert(output, 'Unexpected file removal.');
    assert.equal(
      output.sha256,
      item.replacement ? hash(item.replacement) : item.sha256,
      `Unauthorized byte change: ${item.path}`,
    );
    assert.equal(output.executable, item.executable, 'Executable bit changed.');
    actual.delete(item.path);
  }
  assert.equal(actual.size, 0, 'Unexpected file addition.');
  assert.equal((await inspectCandidate(root, { scan: false })).sha256, before.sha256, 'Source staging changed.');
  return {
    before: { files: before.files, bytes: before.bytes, sha256: before.sha256 },
    after,
    omitted: plan.filter((item) => item.action === 'omit').map((item) => item.path),
    manifests: plan
      .filter((item) => item.action === 'normalize-owned-manifest')
      .map((item) => ({ path: item.path, beforeSha256: item.sha256, afterSha256: hash(item.replacement) })),
    unchangedFiles: plan.filter((item) => item.action === 'copy').length,
  };
}

export async function inspectCandidate(directory, { scan = true, forbiddenRoots = [] } = {}) {
  assert((await lstat(directory)).isDirectory(), 'Candidate root must be a real directory.');
  const entries = [];
  const paths = new Set();
  let bytes = 0;
  let files = 0;
  const markers = [
    ...new Set(
      forbiddenRoots.flatMap((root) => {
        assert(typeof root === 'string' && root.length > 4, 'Forbidden roots must be explicit, nontrivial paths.');
        return [root, root.replaceAll('\\', '/'), root.replaceAll('\\', '\\\\'), encodeURI(root)];
      }),
    ),
  ].flatMap((value) => [Buffer.from(value), Buffer.from(value, 'utf16le')]);
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      const relative = path.relative(directory, file).split(path.sep).join('/');
      validateCandidatePath(relative);
      const key = relative.normalize('NFC').toLowerCase();
      assert(!paths.has(key), `Case/Unicode path collision: ${relative}`);
      paths.add(key);
      assert(paths.size <= CANDIDATE_LIMITS.entries, 'Candidate entry limit exceeded.');
      assert(entry.isDirectory() || entry.isFile(), `Links and special entries are forbidden: ${relative}`);
      if (entry.isDirectory()) {
        entries.push({ path: relative, type: 'directory' });
        await walk(file);
        continue;
      }
      const info = await lstat(file);
      assert(info.isFile());
      assert(info.size <= CANDIDATE_LIMITS.fileBytes, 'Candidate file limit exceeded.');
      bytes += info.size;
      assert(bytes <= CANDIDATE_LIMITS.totalBytes, 'Candidate byte limit exceeded.');
      const content = await readFile(file);
      if (scan) {
        assert(!markers.some((marker) => content.includes(marker)), `Build path marker: ${relative}`);
        const text = content.toString('latin1');
        assert(
          !/(?:(?:^|[^A-Za-z0-9_])(?:ck_[A-Za-z0-9._-]{40,}|npm_[A-Za-z0-9]{30,}|ghp_[A-Za-z0-9]{30,})|-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----\s*[A-Za-z0-9+/=\r\n]{64,})/u.test(
            text,
          ),
          `Credential-like content: ${relative}`,
        );
        assert(
          !NORMALIZATION_METADATA.includes(relative) && !relative.startsWith('node_modules/.pnpm/'),
          `Package-manager metadata: ${relative}`,
        );
      }
      files++;
      entries.push({
        path: relative,
        type: 'file',
        size: content.length,
        sha256: hash(content),
        executable: Boolean(info.mode & 0o111),
      });
    }
  }
  await walk(directory);
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const serialized = `${JSON.stringify({ schemaVersion: 1, entries })}\n`;
  assert(Buffer.byteLength(serialized) <= CANDIDATE_LIMITS.fileListBytes, 'File inventory limit exceeded.');
  return { files, bytes, entries, sha256: hash(serialized), fileListBytes: Buffer.byteLength(serialized) };
}

export function validateCandidatePath(relative) {
  assert(relative && Buffer.byteLength(relative) <= CANDIDATE_LIMITS.pathBytes);
  assert(
    !relative.startsWith('/') &&
      !/[\\:]/u.test(relative) &&
      ![...relative].some((character) => character.codePointAt(0) < 32 || character.codePointAt(0) === 127),
    'Invalid candidate path.',
  );
  for (const part of relative.split('/')) {
    assert(part && part !== '.' && part !== '..' && !/[. ]$/u.test(part), 'Invalid candidate path segment.');
    assert(!/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part), 'Windows reserved path.');
    assert(
      !/^(?:\.git|\.npmrc)$/iu.test(part) &&
        !/^\.env(?:$|\.(?!example$))/iu.test(part) &&
        !/\.(?:pem|key|p12|pfx)$/iu.test(part),
      'Sensitive candidate entry.',
    );
  }
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}
