import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { extract } from 'tar-stream';
import {
  WORKSPACE_SNAPSHOT_LIMITS as limits,
  validateWorkspacePayload,
  type SerializedWorkspacePayload,
  type WorkspaceManifestEntry,
} from '@yanbot-harness/workspace-snapshot';
import { CloudError, invalidConfiguration, workspaceLimitExceeded } from '../common/cloud-error.js';

let active = 0;

/** Fetches only public GitHub exports. No git process, credentials or archive extraction to disk. */
export async function fetchGitSnapshot(repository: string, commit: string): Promise<SerializedWorkspacePayload> {
  const url = new URL(repository);
  const match = /^\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/u.exec(url.pathname);
  if (
    url.origin !== 'https://github.com' ||
    !match ||
    !/^[a-f0-9]{40}$/u.test(commit) ||
    ['.', '..'].includes(match[2]!)
  ) {
    throw invalidConfiguration('Git materialization supports public github.com owner/repository sources only.');
  }
  if (active >= 2) throw new CloudError(429, 'HARNESS_FAILED', 'Git preparation capacity is busy.', true);
  active++;
  try {
    const signal = AbortSignal.timeout(30_000);
    const response = await fetch(`https://codeload.github.com/${match[1]}/${match[2]}/tar.gz/${commit}`, {
      redirect: 'error',
      signal,
      headers: { 'user-agent': 'yanbot-harness', accept: 'application/gzip' },
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw invalidConfiguration('The pinned public Git source could not be downloaded.');
    }
    return await decodeGitArchive(Readable.fromWeb(response.body as never), signal);
  } catch (error) {
    if (error instanceof CloudError) throw error;
    throw invalidConfiguration('The Git archive is unavailable, unsafe, or exceeds the preparation deadline.');
  } finally {
    active--;
  }
}

export async function decodeGitArchive(source: Readable, signal?: AbortSignal): Promise<SerializedWorkspacePayload> {
  const archive = extract();
  const entries: WorkspaceManifestEntry[] = [];
  const files: SerializedWorkspacePayload['files'] = [];
  let root: string | undefined;
  let total = 0;
  const seen = new Set<string>();
  archive.on('entry', (header, stream, next) => {
    void (async () => {
      const name = header.name.replace(/\/$/u, '');
      const segments = name.split('/');
      if (!root) root = segments[0];
      if (
        !root ||
        segments[0] !== root ||
        segments.some((item) => !item || item === '.' || item === '..') ||
        name.includes('\\') ||
        name.includes('\0')
      )
        throw invalidConfiguration('Unsafe Git archive path.');
      if (
        !['file', 'directory'].includes(header.type ?? '') ||
        header.linkname ||
        header.size === undefined ||
        header.size < 0
      )
        throw invalidConfiguration('Git links and special files are unsupported.');
      if (segments.length === 1) {
        if (header.type !== 'directory' || header.size !== 0) throw invalidConfiguration('Invalid Git archive root.');
        stream.resume();
        next();
        return;
      }
      const relative = segments.slice(1).join('/');
      if (
        segments.some((part) => ['.git', '.gitmodules'].includes(part.toLowerCase())) ||
        seen.has(relative.toLowerCase())
      )
        throw invalidConfiguration('Git metadata, submodules and duplicate paths are unsupported.');
      seen.add(relative.toLowerCase());
      if (seen.size > limits.entries || header.size > limits.fileBytes || (total += header.size) > limits.totalBytes)
        throw workspaceLimitExceeded();
      if (header.type === 'directory') {
        if (header.size !== 0) throw invalidConfiguration('Invalid Git directory.');
        entries.push({ path: relative, type: 'directory' });
        stream.resume();
      } else {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of stream) {
          const bytes = Buffer.from(chunk as Uint8Array);
          if ((size += bytes.length) > header.size) throw workspaceLimitExceeded();
          chunks.push(bytes);
        }
        const bytes = Buffer.concat(chunks);
        if (
          size !== header.size ||
          bytes.subarray(0, 43).toString().startsWith('version https://git-lfs.github.com/spec/v1')
        )
          throw invalidConfiguration('Git LFS pointers and truncated files are unsupported.');
        entries.push({
          path: relative,
          type: 'file',
          size,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          executable: ((header.mode ?? 0) & 0o111) !== 0,
        });
        files.push({ path: relative, contentBase64: bytes.toString('base64') });
      }
      next();
    })().catch((error: unknown) => archive.destroy(error instanceof Error ? error : new Error('Invalid archive.')));
  });
  await pipeline(
    source,
    boundedBytes(limits.totalBytes),
    createGunzip(),
    boundedBytes(limits.totalBytes + limits.entries * 4096),
    archive,
    { ...(signal ? { signal } : {}) },
  );
  if (!root) throw invalidConfiguration('Empty Git archive.');
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const payload = { manifest: { schemaVersion: 1 as const, entries }, files };
  validateWorkspacePayload(payload.manifest, payload.files);
  return payload;
}

function boundedBytes(maximum: number): Transform {
  let size = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      callback(size > maximum ? workspaceLimitExceeded() : null, chunk);
    },
  });
}
