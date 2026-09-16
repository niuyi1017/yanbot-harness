import { mkdtemp, mkdir, writeFile, rm, chmod, symlink } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { vmEnvironment, workspaceShares, vmForwardHeaders } from '../src/macos-vm-host.js';

const roots: string[] = [];
async function temporary() {
  const root = await mkdtemp(path.join(tmpdir(), 'vm-sdk-unit-'));
  roots.push(root);
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
describe('VM resource boundary', () => {
  it('keeps each HTTP hop independent without rewriting business headers or mutating input', () => {
    const input = {
      connection: 'keep-alive, X-Private-Hop',
      'keep-alive': 'timeout=5',
      'x-private-hop': 'remove',
      'transfer-encoding': 'chunked',
      trailer: 'X-Trailer',
      upgrade: 'websocket',
      authorization: 'Bearer test',
      'content-type': 'text/event-stream',
      'last-event-id': 'cursor',
    };
    expect(vmForwardHeaders(input)).toEqual({
      authorization: 'Bearer test',
      'content-type': 'text/event-stream',
      'last-event-id': 'cursor',
    });
    expect(input.connection).toBe('keep-alive, X-Private-Hop');
  });
  it('copies only the explicit allowlist, never ambient HOME, PATH, loaders or signing credentials', async () => {
    expect(
      await vmEnvironment({
        HOME: '/private/home',
        PATH: '/secret/bin',
        NODE_OPTIONS: '--inspect',
        HARNESS_RELEASE_KEY_FILE: '/secret/key',
        CODEBUDDY_API_KEY: 'explicit-test-key',
      }),
    ).toEqual({ CODEBUDDY_API_KEY: 'explicit-test-key' });
    expect(await vmEnvironment({})).toEqual({});
    await expect(vmEnvironment({ CODEBUDDY_CODE_PATH: '/host/tool.js' })).rejects.toThrow('host-side');
    await expect(vmEnvironment({ CODEBUDDY_API_KEY: 'x', CODEBUDDY_API_KEY_FILE: '/not-read' })).rejects.toThrow(
      'exactly one',
    );
  });
  it.skipIf(process.platform === 'win32')(
    'reads a private bounded credential once; rejects broad permissions and links',
    async () => {
      const root = await temporary();
      const file = path.join(root, 'key');
      await writeFile(file, 'test-key\n', { mode: 0o600 });
      expect(await vmEnvironment({ CODEBUDDY_API_KEY_FILE: file })).toEqual({ CODEBUDDY_API_KEY: 'test-key' });
      await chmod(file, 0o644);
      await expect(vmEnvironment({ CODEBUDDY_API_KEY_FILE: file })).rejects.toThrow('private');
      await chmod(file, 0o600);
      await writeFile(file, 'a\nb\n');
      await expect(vmEnvironment({ CODEBUDDY_API_KEY_FILE: file })).rejects.toThrow('one-line');
      await writeFile(file, 'x'.repeat(16385));
      await expect(vmEnvironment({ CODEBUDDY_API_KEY_FILE: file })).rejects.toThrow('bounded');
      await symlink(file, path.join(root, 'link'));
      await expect(vmEnvironment({ CODEBUDDY_API_KEY_FILE: path.join(root, 'link') })).rejects.toThrow();
    },
  );
  it('requires dedicated unique explicitly named directories and preserves read-only intent', async () => {
    const root = await temporary();
    const workspace = path.join(root, '工作区 spaces');
    await mkdir(workspace);
    const shares = await workspaceShares([{ path: workspace, readOnly: true }]);
    expect(shares).toEqual([{ name: 'workspace-0', path: expect.stringContaining('工作区 spaces'), readOnly: true }]);
    expect(await workspaceShares([])).toEqual([]);
    await expect(workspaceShares([{ path: homedir(), readOnly: true }])).rejects.toThrow('dedicated');
    await expect(
      workspaceShares([
        { path: workspace, readOnly: true },
        { path: workspace, readOnly: false },
      ]),
    ).rejects.toThrow('unique');
    await expect(workspaceShares([{ path: 'relative', readOnly: false }])).rejects.toThrow('absolute');
  });
});
