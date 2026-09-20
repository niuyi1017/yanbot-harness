import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { serializeWorkspaceSnapshot } from '../src/snapshot.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe('CLI snapshot serialization', () => {
  it('serializes regular files, preserves mode and omits Git metadata', async () => {
    const root = await temporaryRoot();
    await mkdir(path.join(root, '.git'));
    await writeFile(path.join(root, '.git', 'config'), 'must not upload');
    await writeFile(path.join(root, 'index.txt'), 'hello', { mode: 0o700 });
    await expect(serializeWorkspaceSnapshot(root)).resolves.toMatchObject({
      manifest: { entries: [{ path: 'index.txt', type: 'file', size: 5, executable: true }] },
      files: [{ path: 'index.txt', contentBase64: 'aGVsbG8=' }],
    });
  });

  it('rejects symlinks and secret files without including their paths in the error', async () => {
    const root = await temporaryRoot();
    await writeFile(path.join(root, 'target'), 'hello');
    await symlink('target', path.join(root, 'linked'));
    await expect(serializeWorkspaceSnapshot(root)).rejects.toThrow('unsupported file');
    await rm(path.join(root, 'linked'));
    await writeFile(path.join(root, '.env'), 'secret');
    const error = await serializeWorkspaceSnapshot(root).catch((reason: unknown) => reason);
    expect(String(error)).not.toContain('.env');
    expect(String(error)).not.toContain('secret');
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'yanbot-cli-snapshot-'));
  roots.push(root);
  return root;
}
