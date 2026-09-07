import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ConfigLoaderError, readConfigLayer, resolveConfigLayers, type ConfigLayer } from '../src/index.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe('config loader', () => {
  it('applies fixed precedence, deep merge, array replacement, and null tombstones', () => {
    const layers: ConfigLayer[] = [
      layer('enforced', { adapter: { nested: { policy: 'locked' }, final: true } }),
      layer('local', { adapter: { nested: { local: true }, list: [1, 2], removed: true } }),
      layer('user', { adapter: { nested: { user: true }, list: [3] } }),
      layer('project', { adapter: { nested: { policy: 'project' }, removed: null } }),
    ];

    expect(resolveConfigLayers(layers, ['local', 'user', 'project'])).toMatchObject({
      adapterConfig: {
        nested: { local: true, user: true, policy: 'locked' },
        list: [3],
        final: true,
      },
      publicSummary: { scopes: ['local', 'user', 'project', 'enforced'] },
    });
  });

  it('merges extensions and credential references without exposing values in the summary', () => {
    const result = resolveConfigLayers(
      [
        layer('user', {
          extensions: [{ extensionId: 'example.skill', enabled: true }],
          credentialRefs: { API_KEY: 'keychain:codebuddy' },
        }),
        layer('enforced', {
          extensions: [{ extensionId: 'example.skill', enabled: false }],
          credentialRefs: { API_KEY: 'env:CODEBUDDY_API_KEY' },
        }),
      ],
      ['user'],
    );

    expect(result.extensionSelections).toMatchObject([{ extensionId: 'example.skill', enabled: false }]);
    expect(result.credentialRefs).toEqual({ API_KEY: 'env:CODEBUDDY_API_KEY' });
    expect(JSON.stringify(result.publicSummary)).not.toContain('CODEBUDDY_API_KEY');
    expect(result.publicSummary.credentialKeys).toEqual(['API_KEY']);
  });

  it('rejects prototype pollution keys', () => {
    const values = JSON.parse('{"adapter":{"__proto__":{"polluted":true}}}') as ConfigLayer['values'];
    expect(() => resolveConfigLayers([layer('local', values)], ['local'])).toThrow(ConfigLoaderError);
  });

  it('rejects type conflicts and inline credential values with stable errors', () => {
    expect(() =>
      resolveConfigLayers(
        [layer('local', { adapter: { mode: 'safe' } }), layer('user', { adapter: { mode: { nested: true } } })],
        ['local', 'user'],
      ),
    ).toThrowError(expect.objectContaining({ code: 'CONFIGURATION_INVALID' }));
    expect(() => resolveConfigLayers([layer('local', { adapter: { apiKey: 'secret' } })], ['local'])).toThrowError(
      expect.objectContaining({ code: 'CONFIGURATION_INVALID' }),
    );
  });

  it('only reads a config file whose real path is inside the allowed root', async () => {
    const parent = await temporaryRoot();
    const allowed = path.join(parent, 'allowed');
    const outside = path.join(parent, 'outside');
    await mkdir(allowed);
    await mkdir(outside);
    const config = path.join(allowed, 'config.json');
    await writeFile(config, '{"adapter":{"mode":"safe"}}', 'utf8');
    await expect(readConfigLayer({ file: config, allowedRoot: allowed, scope: 'project' })).resolves.toMatchObject({
      sourceRef: 'project:config',
    });

    const outsideConfig = path.join(outside, 'config.json');
    await writeFile(outsideConfig, '{"adapter":{}}', 'utf8');
    const linked = path.join(allowed, 'linked.json');
    await symlink(outsideConfig, linked, 'file');
    await expect(readConfigLayer({ file: linked, allowedRoot: allowed, scope: 'project' })).rejects.toMatchObject({
      code: 'CONFIGURATION_OUTSIDE_ROOT',
    });
  });

  it('wraps missing and malformed config files in stable errors', async () => {
    const root = await temporaryRoot();
    await expect(
      readConfigLayer({ file: path.join(root, 'missing.json'), allowedRoot: root, scope: 'project' }),
    ).rejects.toMatchObject({ code: 'CONFIGURATION_INVALID' });
    const malformed = path.join(root, 'malformed.json');
    await writeFile(malformed, '{', 'utf8');
    await expect(readConfigLayer({ file: malformed, allowedRoot: root, scope: 'project' })).rejects.toMatchObject({
      code: 'CONFIGURATION_INVALID',
    });
  });
});

function layer(scope: ConfigLayer['scope'], values: ConfigLayer['values']): ConfigLayer {
  return { scope, values, sourceRef: `${scope}:test` };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'yanbot-harness-config-'));
  roots.push(root);
  return root;
}
