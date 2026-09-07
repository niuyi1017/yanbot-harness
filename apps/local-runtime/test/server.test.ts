import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ReferenceAdapter } from '@yanbot-harness/adapter-reference';
import { afterEach, describe, expect, it } from 'vitest';

import { FileLocalStateStore } from '../src/local-state-store.js';
import { startLocalRuntime } from '../src/server.js';

const roots: string[] = [];

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe('local runtime server', () => {
  it('listens on loopback, writes a private descriptor, and closes idempotently', async () => {
    const root = await temporaryRoot();
    const descriptorPath = path.join(root, 'runtime.json');
    const runtime = await startLocalRuntime({
      stateRoot: path.join(root, 'state'),
      runtimeDescriptorPath: descriptorPath,
      adapters: [new ReferenceAdapter()],
      accessToken: 'server-access-secret',
    });

    expect(runtime.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8')) as Record<string, unknown>;
    expect(descriptor).toMatchObject({
      schemaVersion: 1,
      origin: runtime.origin,
      accessToken: 'server-access-secret',
      pid: process.pid,
    });
    if (process.platform !== 'win32') expect((await stat(descriptorPath)).mode & 0o777).toBe(0o600);
    await expect((await fetch(`${runtime.origin}/local/health`)).json()).resolves.toMatchObject({ status: 'ok' });

    await Promise.all([runtime.close(), runtime.close()]);
    await expect(access(descriptorPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(root, 'state', 'store.json'), 'utf8')).not.toContain('server-access-secret');
  });

  it('rejects non-loopback listeners before creating a descriptor', async () => {
    const root = await temporaryRoot();
    const descriptorPath = path.join(root, 'runtime.json');
    await expect(
      startLocalRuntime({
        stateRoot: path.join(root, 'state'),
        runtimeDescriptorPath: descriptorPath,
        adapters: [new ReferenceAdapter()],
        host: '0.0.0.0',
      }),
    ).rejects.toThrow('loopback');
    await expect(access(descriptorPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cancels an active run before releasing the listener and descriptor', async () => {
    const root = await temporaryRoot();
    const workspace = path.join(root, 'workspace');
    const stateRoot = path.join(root, 'state');
    const descriptorPath = path.join(root, 'runtime.json');
    await mkdir(workspace);
    const runtime = await startLocalRuntime({
      stateRoot,
      runtimeDescriptorPath: descriptorPath,
      adapters: [new ReferenceAdapter({ scenario: { kind: 'wait-for-cancel' } })],
      accessToken: 'server-access-secret',
      shutdownGraceMs: 1_000,
    });
    const request = (pathname: string, body: unknown) =>
      fetch(`${runtime.origin}${pathname}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${runtime.accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const grant = (await (await request('/local/workspaces/grants', { path: workspace })).json()) as {
      grant: string;
    };
    const session = (await (await request('/local/sessions', { adapterId: 'cn.yanbot.reference' })).json()) as {
      sessionId: string;
    };
    const created = (await (
      await request(`/local/sessions/${session.sessionId}/runs`, {
        prompt: 'Wait for shutdown',
        workspaceGrant: grant.grant,
      })
    ).json()) as { run: { runId: string } };

    await runtime.close();
    const recovered = new FileLocalStateStore({ stateRoot });
    await recovered.initialize();
    await expect(recovered.getRun(created.run.runId)).resolves.toMatchObject({
      status: 'cancelled',
      terminalEventType: 'run.cancelled',
    });
    await expect(access(descriptorPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('releases its listener when startup descriptor creation fails', async () => {
    const root = await temporaryRoot();
    const port = await availablePort();
    const blockingFile = path.join(root, 'not-a-directory');
    await writeFile(blockingFile, 'blocked', 'utf8');
    await expect(
      startLocalRuntime({
        stateRoot: path.join(root, 'state'),
        runtimeDescriptorPath: path.join(blockingFile, 'runtime.json'),
        adapters: [new ReferenceAdapter()],
        port,
      }),
    ).rejects.toBeDefined();

    const replacement = createServer();
    await new Promise<void>((resolve, reject) => {
      replacement.once('error', reject);
      replacement.listen(port, '127.0.0.1', resolve);
    });
    await new Promise<void>((resolve, reject) => replacement.close((error) => (error ? reject(error) : resolve())));
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'yanbot-harness-server-'));
  roots.push(root);
  return root;
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP server address.');
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}
