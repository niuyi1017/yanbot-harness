import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverSkills, discoverMcpServers, snapshotExtensions, extensionSnapshotIdentity } from '../src/index.js';

const roots: string[] = [];
const capabilities = {
  'extensions.skills': { level: 'native' as const },
  'extensions.mcp': { level: 'native' as const },
};
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'extension-snapshots-'));
  roots.push(root);
  await mkdir(path.join(root, 'skill'));
  await writeFile(path.join(root, 'skill', 'SKILL.md'), '---\nname: sample\nversion: 1.0.0\n---\nSample instructions.');
  return root;
}
const selection = [{ extensionId: 'sample', enabled: true }];
describe('immutable extension snapshots', () => {
  it('discovers Windows CRLF frontmatter with the same ID and version', async () => {
    const root = await fixture();
    await writeFile(
      path.join(root, 'skill', 'SKILL.md'),
      '---\r\nname: windows-skill\r\nversion: 2.0.0\r\n---\r\nText',
    );
    expect((await discoverSkills([{ path: root, source: 'project' }]))[0]?.descriptor).toMatchObject({
      extensionId: 'windows-skill',
      version: '2.0.0',
    });
  });
  it('rejects aggregate size and nesting limits before adapter execution', async () => {
    const root = await fixture();
    const discovered = await discoverSkills([{ path: root, source: 'project' }]);
    let nested = path.join(root, 'skill');
    for (let index = 0; index < 9; index += 1) {
      nested = path.join(nested, 'deep');
      await mkdir(nested);
    }
    await expect(snapshotExtensions(selection, discovered, capabilities)).rejects.toMatchObject({
      code: 'EXTENSION_INVALID',
    });
    await rm(path.join(root, 'skill', 'deep'), { recursive: true });
    for (let index = 0; index < 9; index += 1)
      await writeFile(path.join(root, 'skill', `${index}.txt`), 'x'.repeat(262144));
    await expect(snapshotExtensions(selection, discovered, capabilities)).rejects.toMatchObject({
      code: 'EXTENSION_INVALID',
    });
  });
  it('owns bounded portable content, remains stable after source edits, and exposes no source path', async () => {
    const root = await fixture();
    await writeFile(path.join(root, 'skill', 'guide.txt'), 'supporting content');
    const discovered = await discoverSkills([{ path: root, source: 'project' }]);
    const snapshots = await snapshotExtensions(selection, discovered, capabilities);
    expect(snapshots[0]).toMatchObject({
      kind: 'skill',
      version: '1.0.0',
      resource: { files: [{ path: 'guide.txt' }, { path: 'SKILL.md' }] },
    });
    expect(Object.isFrozen(snapshots)).toBe(true);
    expect(Object.isFrozen(snapshots[0]?.resource)).toBe(true);
    expect(JSON.stringify(snapshots)).not.toContain(root);
    const identity = extensionSnapshotIdentity(snapshots);
    await writeFile(path.join(root, 'skill', 'guide.txt'), 'changed');
    expect(extensionSnapshotIdentity(snapshots)).toBe(identity);
    expect(extensionSnapshotIdentity(await snapshotExtensions(selection, discovered, capabilities))).not.toBe(identity);
  });
  it('rejects descriptor resource drift after discovery', async () => {
    const root = await fixture();
    const discovered = await discoverSkills([{ path: root, source: 'project' }]);
    await writeFile(path.join(root, 'skill', 'SKILL.md'), 'changed metadata');
    await expect(snapshotExtensions(selection, discovered, capabilities)).rejects.toMatchObject({
      code: 'EXTENSION_INVALID',
    });
  });
  it.skipIf(process.platform === 'win32').each(['CON.txt', 'bad. ', 'colon:name', 'UPPER'])(
    'rejects nonportable path %s or case collision',
    async (name) => {
      const root = await fixture();
      if (name === 'UPPER') {
        await writeFile(path.join(root, 'skill', 'upper'), 'a');
      }
      await writeFile(path.join(root, 'skill', name), 'b');
      // Case-insensitive hosts cannot create both variants; the portable-name cases still execute there.
      if (name === 'UPPER' && process.platform !== 'linux') return;
      await expect(
        snapshotExtensions(selection, await discoverSkills([{ path: root, source: 'project' }]), capabilities),
      ).rejects.toMatchObject({ code: 'EXTENSION_INVALID' });
    },
  );
  it.skipIf(process.platform === 'win32')('rejects symlink files and nested directory links', async () => {
    const root = await fixture();
    await symlink(path.join(root, 'skill', 'SKILL.md'), path.join(root, 'skill', 'link.md'));
    await expect(
      snapshotExtensions(selection, await discoverSkills([{ path: root, source: 'project' }]), capabilities),
    ).rejects.toMatchObject({ code: 'EXTENSION_INVALID' });
  });
  it('rejects oversized content, wrong versions, duplicate selection, and arbitrary config', async () => {
    const root = await fixture();
    const discovered = await discoverSkills([{ path: root, source: 'project' }]);
    for (const selected of [
      [...selection, ...selection],
      [{ ...selection[0]!, version: '2.0.0' }],
      [{ ...selection[0]!, config: { prompt: 'override' } }],
    ]) {
      await expect(snapshotExtensions(selected, discovered, capabilities)).rejects.toMatchObject({
        code: 'EXTENSION_INVALID',
      });
    }
    await writeFile(path.join(root, 'skill', 'big.txt'), 'a'.repeat(262145));
    await expect(snapshotExtensions(selection, discovered, capabilities)).rejects.toMatchObject({
      code: 'EXTENSION_INVALID',
    });
  });
  it.each([
    { command: 'node', env: { API_KEY: 'must-not-leak' } },
    { type: 'http', url: 'https://example.test' },
    { command: 'npx.cmd', args: ['fixture'] },
    { command: 'cmd.exe', args: ['/c', 'anything'] },
    { command: 'node', args: ['--token=must-not-leak'] },
    { command: 'node', unknown: 'must-not-leak' },
  ])('rejects unreviewed MCP launch configuration %j', async (server) => {
    const root = await fixture();
    const file = path.join(root, 'mcp.json');
    await writeFile(file, JSON.stringify({ mcpServers: { sample: server } }));
    const discovered = await discoverMcpServers({ file, allowedRoot: root, source: 'bundled' });
    try {
      await snapshotExtensions([{ extensionId: 'mcp.sample', enabled: true }], discovered, capabilities);
      throw new Error('Expected rejection');
    } catch (error) {
      expect(error).toMatchObject({ code: 'EXTENSION_INVALID' });
      expect(String(error)).not.toContain('must-not-leak');
      expect(String(error)).not.toContain(root);
    }
  });
  it('accepts stdio argv and logical credential bindings, pins credential reference changes', async () => {
    const root = await fixture();
    const file = path.join(root, 'mcp.json');
    await writeFile(
      file,
      JSON.stringify({
        mcpServers: {
          sample: {
            command: 'node.exe',
            args: ['C:\\Demo Files\\fixture.js'],
            envCredentialRefs: { API_KEY: 'fixture-key' },
          },
        },
      }),
    );
    const discovered = await discoverMcpServers({ file, allowedRoot: root, source: 'bundled' });
    expect(discovered[0]?.descriptor.credentialRefs).toEqual(['fixture-key']);
    const snapshots = await snapshotExtensions(
      [{ extensionId: 'mcp.sample', enabled: true }],
      discovered,
      capabilities,
    );
    expect(snapshots[0]).toMatchObject({
      kind: 'mcp',
      resource: { transport: 'stdio', args: ['C:\\Demo Files\\fixture.js'] },
    });
    expect(extensionSnapshotIdentity(snapshots, { 'fixture-key': 'env:A' })).not.toBe(
      extensionSnapshotIdentity(snapshots, { 'fixture-key': 'env:B' }),
    );
  });
});
