import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { discoverMcpServers, discoverSkills, ExtensionKitError, resolveExtensions } from '../src/index.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe('extension kit', () => {
  it('discovers skill metadata without exposing its absolute resource path in the descriptor', async () => {
    const root = await temporaryRoot();
    const skill = path.join(root, 'safe-skill');
    await mkdir(skill);
    await writeFile(
      path.join(skill, 'SKILL.md'),
      '---\nname: safe-skill\ndescription: Safe test skill\nversion: 1.2.3\n---\nIgnore this as runtime instructions.\n',
      'utf8',
    );

    const [result] = await discoverSkills([{ path: root, source: 'project' }]);
    expect(result?.descriptor).toMatchObject({
      extensionId: 'safe-skill',
      kind: 'skill',
      version: '1.2.3',
      requiredCapabilities: ['extensions.skills'],
    });
    expect(JSON.stringify(result?.descriptor)).not.toContain(root);
    expect(result?.resourcePath).toContain(root);
  });

  it('does not follow a skill symlink outside the trusted root', async () => {
    const parent = await temporaryRoot();
    const root = path.join(parent, 'root');
    const outside = path.join(parent, 'outside', 'escaped');
    await mkdir(root);
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, 'SKILL.md'), '---\nname: escaped\n---\n', 'utf8');
    await symlink(outside, path.join(root, 'escaped'), 'dir');

    expect(await discoverSkills([{ path: root, source: 'project' }])).toEqual([]);
  });

  it('rejects duplicate skill IDs across trusted roots', async () => {
    const parent = await temporaryRoot();
    const firstRoot = path.join(parent, 'first');
    const secondRoot = path.join(parent, 'second');
    await mkdir(path.join(firstRoot, 'one'), { recursive: true });
    await mkdir(path.join(secondRoot, 'two'), { recursive: true });
    await writeFile(path.join(firstRoot, 'one', 'SKILL.md'), '---\nname: duplicated\n---\n', 'utf8');
    await writeFile(path.join(secondRoot, 'two', 'SKILL.md'), '---\nname: duplicated\n---\n', 'utf8');

    await expect(
      discoverSkills([
        { path: firstRoot, source: 'user' },
        { path: secondRoot, source: 'project' },
      ]),
    ).rejects.toMatchObject({ code: 'EXTENSION_INVALID' });
  });

  it('discovers MCP metadata without exposing credential values', async () => {
    const root = await temporaryRoot();
    const file = path.join(root, 'mcp.json');
    await writeFile(
      file,
      JSON.stringify({ mcpServers: { Search: { url: 'https://example.test', apiKey: 'real-secret' } } }),
      'utf8',
    );

    const [result] = await discoverMcpServers({ file, allowedRoot: root, source: 'user' });
    expect(result?.descriptor).toMatchObject({
      extensionId: 'mcp.search',
      credentialRefs: ['apiKey'],
      requiredCapabilities: ['extensions.mcp'],
    });
    expect(JSON.stringify(result?.descriptor)).not.toContain('real-secret');
    expect(JSON.stringify(result?.descriptor)).not.toContain(root);
  });

  it('wraps malformed MCP JSON and rejects normalized ID collisions', async () => {
    const root = await temporaryRoot();
    const malformed = path.join(root, 'malformed.json');
    await writeFile(malformed, '{', 'utf8');
    await expect(discoverMcpServers({ file: malformed, allowedRoot: root, source: 'user' })).rejects.toBeInstanceOf(
      ExtensionKitError,
    );

    const duplicate = path.join(root, 'duplicate.json');
    await writeFile(duplicate, JSON.stringify({ mcpServers: { Search: {}, search: {} } }), 'utf8');
    await expect(discoverMcpServers({ file: duplicate, allowedRoot: root, source: 'user' })).rejects.toMatchObject({
      code: 'EXTENSION_INVALID',
    });
  });

  it('rejects selected extensions when the adapter capability is unsupported', async () => {
    const root = await temporaryRoot();
    const skill = path.join(root, 'safe-skill');
    await mkdir(skill);
    await writeFile(path.join(skill, 'SKILL.md'), '---\nname: safe-skill\n---\n', 'utf8');
    const discovered = await discoverSkills([{ path: root, source: 'project' }]);

    expect(() =>
      resolveExtensions([{ extensionId: 'safe-skill', enabled: true }], discovered, {
        'extensions.skills': { level: 'unsupported', reason: 'Deferred.' },
      }),
    ).toThrowError(expect.objectContaining({ code: 'CAPABILITY_UNSUPPORTED' }));
    expect(
      resolveExtensions([{ extensionId: 'safe-skill', enabled: true }], discovered, {
        'extensions.skills': { level: 'native' },
      }),
    ).toHaveLength(1);
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'yanbot-harness-extension-'));
  roots.push(root);
  return root;
}
