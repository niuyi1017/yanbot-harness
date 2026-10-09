import { Readable } from 'node:stream';
import { gitArchive } from './helpers/git-archive.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeGitArchive, fetchGitSnapshot } from '../src/workspaces/git-snapshot.js';

afterEach(() => vi.unstubAllGlobals());

describe('Immutable Git workspace materialization', () => {
  it('converts a bounded archive into a validated portable snapshot and fixes the upstream host', async () => {
    const archive = await gitArchive([
      { name: 'repo-sha/', type: 'directory' },
      { name: 'repo-sha/src/', type: 'directory' },
      { name: 'repo-sha/src/index.ts', text: 'export const value = 1;' },
    ]);
    const fetcher = vi.fn(async () => new Response(new Uint8Array(archive)));
    vi.stubGlobal('fetch', fetcher);
    const result = await fetchGitSnapshot('https://github.com/example/repo.git', 'a'.repeat(40));
    expect(result.manifest.entries.map((entry) => entry.path)).toEqual(['src', 'src/index.ts']);
    expect(Buffer.from(result.files[0]!.contentBase64, 'base64').toString()).toContain('value = 1');
    expect(fetcher).toHaveBeenCalledWith(
      `https://codeload.github.com/example/repo/tar.gz/${'a'.repeat(40)}`,
      expect.objectContaining({ redirect: 'error' }),
    );
  });

  it.each([
    { name: 'repo/../escape', text: 'bad' },
    { name: 'repo/.git/config', text: 'bad' },
    { name: 'repo/.gitmodules', text: 'bad' },
    { name: 'repo/link', type: 'symlink' as const, linkname: '/etc/passwd' },
    { name: 'repo/link', type: 'link' as const, linkname: 'other' },
    { name: 'repo/file', text: 'version https://git-lfs.github.com/spec/v1\noid sha256:test' },
  ])('rejects unsafe archive entry $name $type', async (entry) => {
    const archive = await gitArchive([entry]);
    await expect(decodeGitArchive(Readable.from([archive]))).rejects.toThrow();
  });

  it('rejects duplicate paths, truncated gzip and unapproved providers without network', async () => {
    const archive = await gitArchive([
      { name: 'repo/a', text: '1' },
      { name: 'repo/A', text: '2' },
    ]);
    await expect(decodeGitArchive(Readable.from([archive]))).rejects.toThrow();
    await expect(decodeGitArchive(Readable.from([archive.subarray(0, 20)]))).rejects.toThrow();
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await expect(fetchGitSnapshot('https://evil.example/repo', 'a'.repeat(40))).rejects.toThrow();
    await expect(fetchGitSnapshot('https://github.com/example/repo/tree/main', 'a'.repeat(40))).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
