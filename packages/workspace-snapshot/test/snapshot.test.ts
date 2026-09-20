import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  WorkspaceSnapshotError,
  validateWorkspaceManifest,
  validateWorkspacePayload,
  writeWorkspaceSnapshot,
  type WorkspaceManifest,
} from '../src/index.js';

const roots: string[] = [];

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe('workspace snapshot', () => {
  it('validates canonical payload bytes and writes a private tree', async () => {
    const bytes = Buffer.from('hello');
    const manifest = workspaceManifest('src/index.txt', bytes, true);
    const payload = validateWorkspacePayload(manifest, [
      { path: 'src/index.txt', contentBase64: bytes.toString('base64') },
    ]);
    expect(validateWorkspaceManifest(manifest, payload.digest).manifest).toEqual(manifest);
    const root = await temporaryRoot();
    const destination = path.join(root, 'tenant', 'workspace-id');
    await writeWorkspaceSnapshot(destination, payload);
    expect(await readFile(path.join(destination, 'src', 'index.txt'), 'utf8')).toBe('hello');
    expect((await lstat(path.join(destination, 'src', 'index.txt'))).mode & 0o777).toBe(0o700);
  });

  it.each([
    ['missing file', []],
    ['extra file', [{ path: 'other.txt', contentBase64: '' }]],
    ['wrong path', [{ path: 'z.txt', contentBase64: '' }]],
    ['invalid base64', [{ path: 'a.txt', contentBase64: '***=' }]],
    ['noncanonical base64', [{ path: 'a.txt', contentBase64: 'AA' }]],
  ])('rejects %s without reflecting payload data', (_name, files) => {
    const manifest = workspaceManifest('a.txt', Buffer.alloc(0), false);
    let caught: unknown;
    try {
      validateWorkspacePayload(manifest, files);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WorkspaceSnapshotError);
    expect(String(caught)).toBe('WorkspaceSnapshotError: The workspace snapshot is invalid.');
    expect(String(caught)).not.toContain('other.txt');
  });

  it('rejects digest and size mismatches', () => {
    const bytes = Buffer.from('hello');
    const manifest = workspaceManifest('a.txt', bytes, false);
    expect(() =>
      validateWorkspacePayload(manifest, [{ path: 'a.txt', contentBase64: Buffer.from('world').toString('base64') }]),
    ).toThrow(WorkspaceSnapshotError);
    expect(() =>
      validateWorkspacePayload({ ...manifest, entries: [{ ...manifest.entries[0]!, size: 4 }] }, [
        { path: 'a.txt', contentBase64: bytes.toString('base64') },
      ]),
    ).toThrow(WorkspaceSnapshotError);
  });

  it('does not overwrite an existing destination', async () => {
    const root = await temporaryRoot();
    const destination = path.join(root, 'workspace-id');
    const payload = validateWorkspacePayload({ schemaVersion: 1, entries: [] }, []);
    await writeWorkspaceSnapshot(destination, payload);
    await expect(writeWorkspaceSnapshot(destination, payload)).rejects.toThrow(WorkspaceSnapshotError);
  });
});

function workspaceManifest(relative: string, bytes: Uint8Array, executable: boolean): WorkspaceManifest {
  const parts = relative.split('/');
  const entries: WorkspaceManifest['entries'] = [];
  for (let index = 1; index < parts.length; index += 1) {
    entries.push({ path: parts.slice(0, index).join('/'), type: 'directory' });
  }
  entries.push({
    path: relative,
    type: 'file',
    size: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    executable,
  });
  return { schemaVersion: 1, entries };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'yanbot-workspace-snapshot-'));
  roots.push(root);
  return root;
}
