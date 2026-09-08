import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readRuntimeDescriptor } from '../src/index.js';

const roots: string[] = [];

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe('Runtime descriptor discovery', () => {
  it('accepts an owned, live loopback descriptor', async () => {
    const file = await descriptorFile();
    const descriptor = await readRuntimeDescriptor({ descriptorPath: file });
    expect(descriptor).toMatchObject({ pid: process.pid, origin: 'http://127.0.0.1:4321' });
  });

  it.runIf(process.platform !== 'win32')('rejects permissions broader than mode 0600', async () => {
    const file = await descriptorFile();
    await chmod(file, 0o644);
    await expect(readRuntimeDescriptor({ descriptorPath: file })).rejects.toMatchObject({ kind: 'authentication' });
  });

  it('rejects non-loopback descriptors', async () => {
    const file = await descriptorFile({ origin: 'https://example.com' });
    await expect(readRuntimeDescriptor({ descriptorPath: file })).rejects.toMatchObject({ kind: 'protocol' });
  });
});

async function descriptorFile(overrides: Record<string, unknown> = {}): Promise<string> {
  const root = path.join(tmpdir(), `yanbot-sdk-${crypto.randomUUID()}`);
  roots.push(root);
  await mkdir(root, { mode: 0o700 });
  const file = path.join(root, 'runtime.json');
  await writeFile(
    file,
    JSON.stringify({
      schemaVersion: 1,
      instanceId: crypto.randomUUID(),
      pid: process.pid,
      origin: 'http://127.0.0.1:4321',
      accessToken: 'descriptor-secret',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      ...overrides,
    }),
    { mode: 0o600 },
  );
  return file;
}
