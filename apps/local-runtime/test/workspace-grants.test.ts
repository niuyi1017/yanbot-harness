import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { WorkspaceGrantError, WorkspaceGrantRegistry } from '../src/workspace-grants.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('WorkspaceGrantRegistry', () => {
  it('resolves the root and real child directories without revealing paths in the grant', async () => {
    const root = await temporaryRoot();
    const child = path.join(root, 'child');
    await mkdir(child);
    const registry = deterministicRegistry();
    const issued = await registry.issue(root);
    const canonicalRoot = await realpath(root);
    const canonicalChild = await realpath(child);

    expect(issued.grant).not.toContain(root);
    expect(await registry.resolve(issued.grant)).toMatchObject({
      path: canonicalRoot,
      workspaceRef: issued.workspaceRef,
    });
    expect(await registry.resolve(issued.grant, 'child')).toMatchObject({ path: canonicalChild });
  });

  it('rejects traversal, prefix siblings, and symlinks outside the grant', async () => {
    const parent = await temporaryRoot();
    const root = path.join(parent, 'workspace');
    const sibling = path.join(parent, 'workspace-other');
    await mkdir(root);
    await mkdir(sibling);
    const registry = deterministicRegistry();
    const issued = await registry.issue(root);

    await expect(registry.resolve(issued.grant, '../workspace-other')).rejects.toMatchObject({
      code: 'WORKSPACE_OUTSIDE_GRANT',
    });
    await expect(registry.resolve(issued.grant, 'C:\\workspace')).rejects.toMatchObject({
      code: 'WORKSPACE_OUTSIDE_GRANT',
    });
    await expect(registry.resolve(issued.grant, '\\server\\share')).rejects.toMatchObject({
      code: 'WORKSPACE_OUTSIDE_GRANT',
    });
    await symlink(sibling, path.join(root, 'outside-link'), 'dir');
    await expect(registry.resolve(issued.grant, 'outside-link')).rejects.toMatchObject({
      code: 'WORKSPACE_OUTSIDE_GRANT',
    });
  });

  it('rejects files, forged secrets, revoked grants, and expired grants', async () => {
    const root = await temporaryRoot();
    const file = path.join(root, 'file.txt');
    await writeFile(file, 'test', 'utf8');
    let now = 1_000;
    const registry = deterministicRegistry(() => now);
    await expect(registry.issue(file)).rejects.toBeInstanceOf(WorkspaceGrantError);
    const issued = await registry.issue(root, 1_000);

    await expect(registry.resolve(`${issued.grantId}.forged`)).rejects.toMatchObject({ code: 'INVALID_GRANT' });
    expect(registry.revoke(issued.grantId)).toBe(true);
    await expect(registry.resolve(issued.grant)).rejects.toMatchObject({ code: 'INVALID_GRANT' });

    const expiring = await registry.issue(root, 1_000);
    now = 2_000;
    await expect(registry.resolve(expiring.grant)).rejects.toMatchObject({ code: 'GRANT_EXPIRED' });
  });

  it('does not accept grants issued by a previous registry instance', async () => {
    const root = await temporaryRoot();
    const issued = await deterministicRegistry().issue(root);

    await expect(deterministicRegistry().resolve(issued.grant)).rejects.toMatchObject({ code: 'INVALID_GRANT' });
  });
});

function deterministicRegistry(now: () => number = () => 1_000): WorkspaceGrantRegistry {
  let id = 0;
  return new WorkspaceGrantRegistry({
    now,
    generateId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
    generateSecret: () => `secret-${id}`,
  });
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'yanbot-harness-workspace-'));
  roots.push(root);
  return root;
}
