import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createArguments } from '../src/policy.js';
import { readSnapshot } from '../src/snapshot.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'sandbox-policy-'));
  roots.push(root);
  const workspace = path.join(root, 'snapshot');
  await mkdir(workspace);
  return {
    deployment: {
      dockerPath: path.resolve('/usr/bin/docker'),
      image: `sha256:${'a'.repeat(64)}`,
      snapshotRoot: root,
      workspacePath: workspace,
    },
    root,
    workspace,
  };
}
const name = () => `harness-sandbox-${randomUUID()}`;
describe('Docker sandbox deployment policy', () => {
  it('sets fixed containment flags and exposes no host mounts or request arguments', async () => {
    const { deployment } = await fixture();
    const { args } = await createArguments(deployment, name());
    for (const flag of [
      '--pull=never',
      '--rm',
      '--network=none',
      '--log-driver=none',
      '--read-only',
      '--user=65532:65532',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges=true',
      '--pids-limit=256',
      '--memory=512m',
      '--memory-swap=512m',
      '--cpus=1',
    ])
      expect(args).toContain(flag);
    expect(args).not.toContain('--mount');
    expect(args.join(' ')).not.toContain(deployment.workspacePath);
  });
  it.each(['latest', 'node:22', '--privileged', 'repo@sha256:bad'])(
    'rejects mutable or malformed image %s',
    async (image) => {
      const { deployment } = await fixture();
      await expect(createArguments({ ...deployment, image }, name())).rejects.toThrow();
    },
  );
  it('rejects root and outside workspaces', async () => {
    const { deployment, root } = await fixture();
    await expect(createArguments({ ...deployment, workspacePath: root }, name())).rejects.toThrow();
    await expect(createArguments({ ...deployment, workspacePath: tmpdir() }, name())).rejects.toThrow();
  });
  it('transfers bytes only from regular snapshot files', async () => {
    const { workspace } = await fixture();
    await mkdir(path.join(workspace, 'nested'));
    await writeFile(path.join(workspace, 'nested', 'input.txt'), '你好');
    expect(await readSnapshot(workspace)).toEqual([
      { path: 'nested/input.txt', base64: Buffer.from('你好').toString('base64') },
    ]);
    await symlink(path.join(workspace, 'nested', 'input.txt'), path.join(workspace, 'link'));
    await expect(readSnapshot(workspace)).rejects.toThrow('special file');
  });
  it('rejects snapshot size overflow before allocating its bytes', async () => {
    const { workspace } = await fixture();
    await writeFile(path.join(workspace, 'large'), Buffer.alloc(16 * 1024 * 1024 + 1));
    await expect(readSnapshot(workspace)).rejects.toThrow('size limit');
  });
});
