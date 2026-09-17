import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadCliProfile } from '../src/profiles.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('CLI profiles', () => {
  it('loads versioned Local and Remote targets without storing credentials', async () => {
    const file = await profileFile({
      schemaVersion: 1,
      profiles: {
        local: { mode: 'local-daemon', descriptorPath: '/runtime.json' },
        remote: {
          mode: 'remote',
          origin: 'https://runtime.example.test',
          tokenEnvironment: 'YANBOT_HARNESS_STAGING_ACCESS_TOKEN',
        },
      },
    });

    await expect(loadCliProfile('local', { profileFile: file })).resolves.toEqual({
      mode: 'local-daemon',
      descriptorPath: '/runtime.json',
    });
    await expect(loadCliProfile('remote', { profileFile: file })).resolves.toEqual({
      mode: 'remote',
      origin: 'https://runtime.example.test',
      tokenEnvironment: 'YANBOT_HARNESS_STAGING_ACCESS_TOKEN',
    });
  });

  it('rejects secrets, unknown versions, and missing profiles', async () => {
    const secret = await profileFile({
      schemaVersion: 1,
      profiles: { remote: { mode: 'remote', origin: 'https://runtime.example.test', accessToken: 'secret' } },
    });
    await expect(loadCliProfile('remote', { profileFile: secret })).rejects.toThrow(/unknown field/u);

    const version = await profileFile({ schemaVersion: 2, profiles: {} });
    await expect(loadCliProfile('missing', { profileFile: version })).rejects.toThrow(/schemaVersion must be 1/u);

    const missing = await profileFile({ schemaVersion: 1, profiles: {} });
    await expect(loadCliProfile('missing', { profileFile: missing })).rejects.toThrow(/was not found/u);

    const unrelatedSecret = await profileFile({
      schemaVersion: 1,
      profiles: {
        remote: {
          mode: 'remote',
          origin: 'https://runtime.example.test',
          tokenEnvironment: 'AWS_SECRET_ACCESS_KEY',
        },
      },
    });
    await expect(loadCliProfile('remote', { profileFile: unrelatedSecret })).rejects.toThrow(
      /YANBOT_HARNESS_\*_ACCESS_TOKEN/u,
    );
  });
});

async function profileFile(value: unknown): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'yanbot-cli-profile-'));
  roots.push(root);
  const file = path.join(root, 'profiles.json');
  await writeFile(file, JSON.stringify(value));
  return file;
}
