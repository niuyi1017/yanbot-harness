import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export const CHECKSUM_FILE = 'SHA256SUMS';

export async function fileSha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export function assertSafeRelativePath(relative) {
  assert(typeof relative === 'string' && relative.length > 0 && relative.length <= 512, 'Unsafe empty path.');
  assert(!path.isAbsolute(relative) && !relative.includes('\\'), 'Unsafe delivery path.');
  assert(
    [...relative].every(
      (character) => character !== ':' && character.codePointAt(0) >= 32 && character.codePointAt(0) !== 127,
    ),
    'Unsafe delivery path characters.',
  );
  const parts = relative.split('/');
  assert(
    parts.every((part) => part && part !== '.' && part !== '..'),
    'Unsafe delivery path segment.',
  );
  assert(!/^[A-Za-z]:/u.test(parts[0]), 'Unsafe drive-qualified delivery path.');
  return relative;
}

export async function inventoryFiles(root, { exclude = new Set() } = {}) {
  const files = [];
  const identities = new Set();
  async function visit(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = assertSafeRelativePath(prefix ? prefix + '/' + entry.name : entry.name);
      const identity = relative.normalize('NFC').toLocaleLowerCase('en-US');
      assert(!identities.has(identity), 'Duplicate or case-colliding delivery path.');
      identities.add(identity);
      const absolute = path.join(root, ...relative.split('/'));
      const info = await lstat(absolute);
      assert(!info.isSymbolicLink(), 'Delivery must not contain symbolic links.');
      if (info.isDirectory()) await visit(absolute, relative);
      else {
        assert(info.isFile(), 'Delivery entries must be regular files.');
        if (!exclude.has(relative)) files.push({ path: relative, size: info.size, sha256: await fileSha256(absolute) });
      }
    }
  }
  await visit(root);
  return files.sort((left, right) => left.path.localeCompare(right.path, 'en'));
}

export function formatChecksums(files) {
  return files.map((file) => `${file.sha256}  ${file.path}`).join('\n') + '\n';
}

export async function verifyChecksums(root) {
  const text = await readFile(path.join(root, CHECKSUM_FILE), 'utf8');
  const expected = text
    .trimEnd()
    .split('\n')
    .map((line) => {
      const match = /^([a-f0-9]{64}) {2}(.+)$/u.exec(line);
      assert(match, 'Invalid SHA256SUMS line.');
      return { sha256: match[1], path: assertSafeRelativePath(match[2]) };
    });
  assert(expected.length > 0, 'Empty SHA256SUMS.');
  const actual = (await inventoryFiles(root, { exclude: new Set([CHECKSUM_FILE]) })).map(({ path, sha256 }) => ({
    sha256,
    path,
  }));
  assert.deepEqual(expected, actual, 'Delivery file set or digest changed.');
  return actual;
}

export function validateArchiveEntries(entries, rootName) {
  const root = assertSafeRelativePath(rootName);
  const identities = new Set();
  for (const raw of entries) {
    const candidate = raw.endsWith('/') ? raw.slice(0, -1) : raw;
    if (!candidate) continue;
    const safe = assertSafeRelativePath(candidate);
    assert(safe === root || safe.startsWith(root + '/'), 'Archive entry escaped the delivery root.');
    const identity = safe.normalize('NFC').toLocaleLowerCase('en-US');
    assert(!identities.has(identity), 'Duplicate or case-colliding archive entry.');
    identities.add(identity);
  }
  assert(identities.has(root.normalize('NFC').toLocaleLowerCase('en-US')), 'Archive root missing.');
}
