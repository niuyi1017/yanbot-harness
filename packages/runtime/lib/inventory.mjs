import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

export const NORMALIZATION_METADATA = Object.freeze([
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'node_modules/.modules.yaml',
  'node_modules/.package-map.json',
  'node_modules/.pnpm-workspace-state-v1.json',
  'node_modules/.pnpm/lock.yaml',
]);
export const CANDIDATE_LIMITS = Object.freeze({
  entries: 100_000,
  totalBytes: 512 * 1024 * 1024,
  fileBytes: 256 * 1024 * 1024,
  pathBytes: 1024,
  fileListBytes: 2 * 1024 * 1024,
});

export async function inspectCandidate(directory, { scan = true, forbiddenRoots = [], signal } = {}) {
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
      signal?.throwIfAborted();
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
      const content = await readFile(file, { signal });
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
