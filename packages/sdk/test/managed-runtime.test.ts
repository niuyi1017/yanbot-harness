import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { startManagedRuntime, type ManagedRuntimeHandle } from '../src/index.js';

const handles: ManagedRuntimeHandle[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.allSettled(handles.splice(0).map((handle) => handle.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('SDK-owned managed Runtime', () => {
  it('starts, connects to, and idempotently closes a Reference Runtime', async () => {
    const runtimeEntry = path.resolve(import.meta.dirname, '../../../apps/local-runtime/dist/main.js');
    const handle = await startManagedRuntime({
      executablePath: runtimeEntry,
      environment: minimalEnvironment(),
      reference: true,
      startupTimeoutMs: 5_000,
      shutdownTimeoutMs: 5_000,
    });
    handles.push(handle);

    await expect(handle.client.health()).resolves.toMatchObject({ status: 'ok', protocolVersion: '1.0.0' });
    await expect(handle.client.listAdapters()).resolves.toMatchObject([
      { manifest: { adapterId: 'cn.yanbot.reference' } },
    ]);
    expect(handle.pid).toBeGreaterThan(0);
    await expect(stat(handle.descriptorPath)).resolves.toMatchObject({ mode: expect.any(Number) });

    await Promise.all([handle.close(), handle.close()]);
    handles.splice(handles.indexOf(handle), 1);
    await expect(stat(path.dirname(handle.descriptorPath))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('resolves the executable from the dedicated environment variable', async () => {
    const runtimeEntry = path.resolve(import.meta.dirname, '../../../apps/local-runtime/dist/main.js');
    const handle = await startManagedRuntime({
      environment: { ...minimalEnvironment(), YANBOT_HARNESS_RUNTIME_PATH: runtimeEntry },
      reference: true,
      startupTimeoutMs: 5_000,
      shutdownTimeoutMs: 5_000,
    });
    handles.push(handle);
    await expect(handle.client.health()).resolves.toMatchObject({ status: 'ok' });
  });

  it('retains a caller-owned state root but removes the owned descriptor', async () => {
    const stateRoot = await fixtureRoot();
    const runtimeEntry = path.resolve(import.meta.dirname, '../../../apps/local-runtime/dist/main.js');
    const handle = await startManagedRuntime({
      executablePath: runtimeEntry,
      environment: minimalEnvironment(),
      stateRoot,
      reference: true,
      startupTimeoutMs: 5_000,
      shutdownTimeoutMs: 5_000,
    });
    handles.push(handle);

    await handle.close();
    handles.splice(handles.indexOf(handle), 1);
    await expect(stat(stateRoot)).resolves.toMatchObject({ mode: expect.any(Number) });
    await expect(stat(handle.descriptorPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports a missing executable as a stable Runtime error', async () => {
    await expect(
      startManagedRuntime({ executablePath: path.join(tmpdir(), crypto.randomUUID()), reference: true }),
    ).rejects.toMatchObject({ kind: 'runtime', message: 'The managed Runtime executable could not be found.' });
  });

  it('fails promptly when the Runtime exits before writing a descriptor', async () => {
    const root = await fixtureRoot();
    const entry = path.join(root, 'exit.mjs');
    await writeFile(entry, 'process.exit(7);\n');
    await expect(
      startManagedRuntime({
        executablePath: entry,
        environment: minimalEnvironment(),
        startupTimeoutMs: 5_000,
        shutdownTimeoutMs: 500,
      }),
    ).rejects.toMatchObject({ kind: 'runtime', message: expect.stringContaining('exit code 7') });
  });

  it('rejects a descriptor that does not belong to the spawned child', async () => {
    const root = await fixtureRoot();
    const entry = path.join(root, 'wrong-owner.mjs');
    await writeFile(
      entry,
      `
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
await writeFile(path.join(process.env.YANBOT_HARNESS_STATE_DIR, 'runtime.json'), JSON.stringify({
  schemaVersion: 1,
  instanceId: crypto.randomUUID(),
  pid: process.ppid,
  origin: 'http://127.0.0.1:4321',
  accessToken: 'fixture-token',
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
}), { mode: 0o600 });
setInterval(() => undefined, 1_000);
`,
    );
    await expect(
      startManagedRuntime({
        executablePath: entry,
        environment: minimalEnvironment(),
        startupTimeoutMs: 5_000,
        shutdownTimeoutMs: 500,
      }),
    ).rejects.toMatchObject({
      kind: 'protocol',
      message: 'The managed Runtime descriptor belongs to an unexpected process.',
    });
  });

  it('times out and cleans SDK-owned state when no descriptor appears', async () => {
    const root = await fixtureRoot();
    const entry = path.join(root, 'wait.mjs');
    await writeFile(entry, 'setInterval(() => undefined, 1_000);\n');
    await expect(
      startManagedRuntime({
        executablePath: entry,
        environment: minimalEnvironment(),
        startupTimeoutMs: 150,
        shutdownTimeoutMs: 500,
      }),
    ).rejects.toMatchObject({
      kind: 'runtime',
      message: 'The managed Runtime did not become ready before the startup timeout.',
    });
  });

  it('refuses to reuse a state root that already contains a descriptor', async () => {
    const root = await fixtureRoot();
    await writeFile(path.join(root, 'runtime.json'), '{}', { mode: 0o600 });
    const runtimeEntry = path.resolve(import.meta.dirname, '../../../apps/local-runtime/dist/main.js');
    await expect(
      startManagedRuntime({
        executablePath: runtimeEntry,
        environment: minimalEnvironment(),
        stateRoot: root,
        reference: true,
      }),
    ).rejects.toMatchObject({
      kind: 'runtime',
      message: expect.stringContaining('already contains a descriptor'),
    });
  });
});

async function fixtureRoot(): Promise<string> {
  const root = path.join(tmpdir(), `yanbot-managed-runtime-${crypto.randomUUID()}`);
  roots.push(root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  return root;
}

function minimalEnvironment(): Readonly<Record<string, string | undefined>> {
  return {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
  };
}
