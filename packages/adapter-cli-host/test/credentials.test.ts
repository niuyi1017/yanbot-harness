import { access, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { withCredentialDirectory } from '../src/index.js';

describe('private credential directory', () => {
  it('writes private files and removes the directory after success', async () => {
    let created = '';
    const result = await withCredentialDirectory({ 'api-key': 'secret-marker' }, async (directory) => {
      created = directory;
      expect(await readFile(path.join(directory, 'api-key'), 'utf8')).toBe('secret-marker');
      if (process.platform !== 'win32') {
        expect((await lstat(directory)).mode & 0o777).toBe(0o700);
        expect((await lstat(path.join(directory, 'api-key'))).mode & 0o777).toBe(0o600);
      }
      return 42;
    });
    expect(result).toBe(42);
    await expect(access(created)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['../key', 'key/subkey', 'key:stream', 'CON', 'key.'])(
    'rejects unsafe file name %s before callback',
    async (name) => {
      let called = false;
      await expect(
        withCredentialDirectory({ [name]: 'secret-marker' }, async () => {
          called = true;
        }),
      ).rejects.toMatchObject({ code: 'CREDENTIAL_ERROR' });
      expect(called).toBe(false);
    },
  );

  it('rejects oversized content and case-insensitive file collisions', async () => {
    await expect(
      withCredentialDirectory({ key: new Uint8Array(256 * 1024 + 1) }, async () => undefined),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_ERROR' });
    await expect(withCredentialDirectory({ Key: 'one', key: 'two' }, async () => undefined)).rejects.toMatchObject({
      code: 'CREDENTIAL_ERROR',
    });
  });

  it('cleans up on callback failure without exposing the error content', async () => {
    let created = '';
    const error = await withCredentialDirectory({ key: 'secret-marker' }, async (directory) => {
      created = directory;
      throw new Error('secret-marker');
    }).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: 'CREDENTIAL_ERROR' });
    expect(String(error)).not.toContain('secret-marker');
    await expect(access(created)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cleans up when cancellation occurs during the operation', async () => {
    const controller = new AbortController();
    let created = '';
    await expect(
      withCredentialDirectory(
        { key: 'secret-marker' },
        async (directory) => {
          created = directory;
          controller.abort();
        },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(access(created)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps concurrent calls in separate directories', async () => {
    const directories = new Set<string>();
    await Promise.all(
      [1, 2].map((number) =>
        withCredentialDirectory({ key: String(number) }, async (directory) => {
          directories.add(directory);
          expect(await readFile(path.join(directory, 'key'), 'utf8')).toBe(String(number));
        }),
      ),
    );
    expect(directories.size).toBe(2);
  });

  it('refuses to delete a replacement directory after identity changes', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'credential-identity-test-'));
    let replacement = '';
    try {
      await expect(
        withCredentialDirectory(
          { key: 'secret-marker' },
          async (directory) => {
            replacement = directory;
            await rename(directory, directory + '-moved');
            await mkdir(directory);
            await writeFile(path.join(directory, 'keep'), 'owned replacement');
          },
          { parentDirectory: parent },
        ),
      ).rejects.toMatchObject({ code: 'CREDENTIAL_CLEANUP_FAILED' });
      expect(await readFile(path.join(replacement, 'keep'), 'utf8')).toBe('owned replacement');
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
