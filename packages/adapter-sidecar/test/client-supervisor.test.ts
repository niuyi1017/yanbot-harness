import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';
import { createWindowsCliJobOwner } from '@yanbot-harness/adapter-cli-host';
import { describe, expect, it } from 'vitest';

import { SidecarError, SidecarSupervisor } from '../src/index.js';

const fixture = fileURLToPath(new URL('./fixtures/fake-sidecar.mjs', import.meta.url));
const nativeHost = process.env.HARNESS_CLI_JOB_HOST;

function options(scenario: string) {
  return {
    executablePath: process.execPath,
    args: [fixture, scenario],
    environment: {},
    clientName: 'sidecar-test',
    clientVersion: '0.1.0',
    expectedAdapterId: 'cn.yanbot.fake-sidecar',
    requestTimeoutMs: 1_000,
    shutdownTimeoutMs: 300,
    ...(process.platform === 'win32' && nativeHost ? { processOwner: createWindowsCliJobOwner(nativeHost) } : {}),
  };
}

describe.skipIf(process.platform === 'win32' && !nativeHost)('Sidecar Client and Supervisor', () => {
  it('correlates requests and decodes split UTF-8/CRLF frames', async () => {
    const events: string[] = [];
    const supervisor = await SidecarSupervisor.start({
      ...options('normal'),
      onEvent: (event) => events.push(event.type),
    });
    try {
      const probe = z.object({ available: z.boolean(), diagnostics: z.array(z.string()) });
      const [first, second] = await Promise.all([
        supervisor.client.request('probe', {}, probe),
        supervisor.client.request('probe', {}, probe),
      ]);
      expect(first).toEqual({ available: true, diagnostics: ['多字节 ✓'] });
      expect(second).toEqual(first);
      expect(events).toEqual(['run.started']);
    } finally {
      await supervisor.dispose();
      await supervisor.dispose();
    }
  });

  it('matches responses by ID even when the Wrapper replies out of order', async () => {
    const supervisor = await SidecarSupervisor.start(options('out-of-order'));
    try {
      const probe = z.object({ available: z.boolean(), diagnostics: z.array(z.string()) });
      const [first, second] = await Promise.all([
        supervisor.client.request('probe', {}, probe),
        supervisor.client.request('probe', {}, probe),
      ]);
      expect(first.diagnostics).toEqual(['first']);
      expect(second.diagnostics).toEqual(['second']);
    } finally {
      await supervisor.dispose();
    }
  });

  it.each(['invalid-json', 'wrong-version', 'wrong-id'])(
    'fails closed for incompatible %s output',
    async (scenario) => {
      await expect(SidecarSupervisor.start(options(scenario))).rejects.toMatchObject({
        code: 'PROTOCOL_ERROR',
      });
    },
  );

  it('fails a stalled handshake within the configured timeout', async () => {
    await expect(SidecarSupervisor.start({ ...options('stall'), requestTimeoutMs: 50 })).rejects.toMatchObject({
      code: 'REQUEST_TIMEOUT',
    });
  });

  it('caps stderr without echoing vendor output', async () => {
    try {
      await SidecarSupervisor.start({ ...options('stderr-flood'), maxStderrBytes: 1_024 });
      throw new Error('Expected the Sidecar to be rejected.');
    } catch (error) {
      expect(error).toBeInstanceOf(SidecarError);
      expect((error as SidecarError).code).toBe('RESOURCE_LIMIT');
      expect((error as SidecarError).message).not.toContain('secret-marker');
    }
  });

  it('does not echo a Wrapper error message into the public exception', async () => {
    const supervisor = await SidecarSupervisor.start(options('remote-error'));
    try {
      await expect(supervisor.client.request('probe', {}, z.object({ available: z.boolean() }))).rejects.toMatchObject({
        code: 'REMOTE_ERROR',
        message: 'Sidecar returned an error.',
      });
    } finally {
      await supervisor.dispose();
    }
  });

  it('rejects an oversized protocol line', async () => {
    const supervisor = await SidecarSupervisor.start({ ...options('oversized-line'), maxLineBytes: 1_024 });
    try {
      await expect(supervisor.client.request('probe', {}, z.object({ available: z.boolean() }))).rejects.toMatchObject({
        code: 'RESOURCE_LIMIT',
      });
    } finally {
      await supervisor.dispose();
    }
  });

  it.skipIf(process.platform === 'win32')('terminates an owned POSIX process group on forced shutdown', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'harness-sidecar-'));
    const pidFile = path.join(directory, 'grandchild.pid');
    const supervisor = await SidecarSupervisor.start({
      ...options('child-tree'),
      args: [fixture, 'child-tree', pidFile],
    });
    try {
      await supervisor.client.request('probe', {}, z.object({ available: z.boolean() }));
      const grandchildPid = Number(await readFile(pidFile, 'utf8'));
      expect(grandchildPid).toBeGreaterThan(0);
      await supervisor.dispose();
      expect(() => process.kill(supervisor.pid!, 0)).toThrow();
      await expectGone(grandchildPid);
    } finally {
      await supervisor.dispose().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects relative executables before spawn', async () => {
    await expect(SidecarSupervisor.start({ ...options('normal'), executablePath: 'node' })).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
    });
  });
});

async function expectGone(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('The Sidecar grandchild was still running after shutdown.');
}
