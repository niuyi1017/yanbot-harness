import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { Buffer } from 'node:buffer';
import { URL } from 'node:url';
/* global fetch, AbortSignal */

// Development-only GitHub artifact retrieval. Tokens and signed URLs stay in memory and are never logged.
const execute = promisify(execFile);
const [id, destination] = process.argv.slice(2);
assert(/^\d+$/u.test(id) && destination);
const token = (await execute('gh', ['auth', 'token'])).stdout.trim();
const endpoint = 'https://api.github.com/repos/niuyi1017/yanbot-harness/actions/artifacts/' + id;
const headers = { authorization: 'Bearer ' + token, accept: 'application/vnd.github+json' };
const metadata = await (await fetch(endpoint, { headers, signal: AbortSignal.timeout(30000) })).json();
assert(metadata.id === Number(id) && !metadata.expired && metadata.size_in_bytes <= 256 * 1024 * 1024);
const redirect = await fetch(endpoint + '/zip', { headers, redirect: 'manual', signal: AbortSignal.timeout(30000) });
assert.equal(redirect.status, 302);
const location = new URL(redirect.headers.get('location'));
assert(
  location.protocol === 'https:' &&
    /(?:\.blob\.core\.windows\.net|\.actions\.githubusercontent\.com)$/u.test(location.hostname),
);
const parts = 8;
const chunkSize = Math.ceil(metadata.size_in_bytes / parts);
const partial = path.resolve(destination) + '.parts-' + id;
await mkdir(partial, { recursive: true, mode: 0o700 });
const identity = JSON.stringify({ id, size: metadata.size_in_bytes, digest: metadata.digest, parts });
const identityPath = path.join(partial, 'identity.json');
try {
  await writeFile(identityPath, identity, { flag: 'wx', mode: 0o600 });
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  assert.equal(await readFile(identityPath, 'utf8'), identity);
}
const chunks = await Promise.all(
  Array.from({ length: parts }, async (_, index) => {
    const chunkPath = path.join(partial, String(index));
    const originalStart = index * chunkSize;
    const end = Math.min(metadata.size_in_bytes - 1, originalStart + chunkSize - 1);
    const previous = (await stat(chunkPath).catch(() => undefined))?.size ?? 0;
    assert(previous <= end - originalStart + 1);
    if (previous === end - originalStart + 1) return readFile(chunkPath);
    const start = originalStart + previous;
    const response = await fetch(location, {
      headers: { range: `bytes=${start}-${end}` },
      signal: AbortSignal.timeout(1800000),
    });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/${metadata.size_in_bytes}`);
    const output = await open(chunkPath, previous ? 'a' : 'wx', 0o600);
    let received = 0;
    try {
      for await (const chunk of response.body) {
        received += chunk.length;
        assert(received <= end - start + 1);
        await output.writeFile(chunk);
      }
    } finally {
      await output.close();
    }
    assert.equal(received, end - start + 1);
    console.log(JSON.stringify({ part: index, status: 'downloaded' }));
    return readFile(chunkPath);
  }),
);
const bytes = Buffer.concat(chunks);
const digest = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
assert.equal(digest, metadata.digest, 'GitHub artifact digest mismatch.');
await mkdir(path.dirname(path.resolve(destination)), { recursive: true, mode: 0o700 });
const output = await open(path.resolve(destination), 'wx', 0o600);
try {
  await output.writeFile(bytes);
} finally {
  await output.close();
}
console.log(JSON.stringify({ id: Number(id), bytes: bytes.length, digest, verified: true }));
