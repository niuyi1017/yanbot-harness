import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { HARNESS_PROTOCOL_VERSION } from '@yanbot-harness/sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { CLI_EXIT, runCli } from '../src/index.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('CLI runtime targets', () => {
  it('documents profiles, Remote targets, and the workspace limitation in help', async () => {
    const io = captureIo();
    await expect(runCli(['--help'], { io })).resolves.toBe(CLI_EXIT.success);
    expect(io.stdoutText()).toContain('--remote HTTPS_URL');
    expect(io.stdoutText()).toContain('--profile NAME');
    expect(io.stdoutText()).toContain('Remote run remains disabled');
    expect(io.stdoutText()).not.toContain('--token');
  });

  it('uses refreshed environment credentials and neutral routes for a Remote profile', async () => {
    const requests: Array<{ authorization: string | null; pathname: string }> = [];
    const environment: Record<string, string | undefined> = { YANBOT_HARNESS_STAGING_ACCESS_TOKEN: 'token-1' };
    const profileFile = await temporaryProfile({
      schemaVersion: 1,
      profiles: {
        staging: {
          mode: 'remote',
          origin: 'https://runtime.example.test',
          tokenEnvironment: 'YANBOT_HARNESS_STAGING_ACCESS_TOKEN',
        },
      },
    });
    const io = captureIo();
    const exit = await runCli(['sessions', '--profile', 'staging', '--profile-file', profileFile, '--json'], {
      io,
      environment,
      fetch: async (input, init) => {
        const pathname = new URL(input instanceof Request ? input.url : input.toString()).pathname;
        requests.push({ pathname, authorization: new Headers(init?.headers).get('authorization') });
        if (pathname === '/v1/health') {
          environment.YANBOT_HARNESS_STAGING_ACCESS_TOKEN = 'token-2';
          return Response.json(remoteDiscovery());
        }
        return Response.json([]);
      },
    });

    expect(exit).toBe(CLI_EXIT.success);
    expect(requests).toEqual([
      { pathname: '/v1/health', authorization: 'Bearer token-1' },
      { pathname: '/v1/sessions', authorization: 'Bearer token-2' },
    ]);
    expect(io.stdoutText()).toBe('[]\n');
  });

  it('rejects Remote run after handshake without sending a local path or creating a Session', async () => {
    const requests: string[] = [];
    const io = captureIo();
    const exit = await runCli(
      ['run', 'do not send cwd', '--remote', 'https://runtime.example.test', '--workspace', '/private/work'],
      {
        io,
        environment: { YANBOT_HARNESS_ACCESS_TOKEN: 'token' },
        cwd: '/implicit/work',
        fetch: async (input) => {
          requests.push(new URL(input instanceof Request ? input.url : input.toString()).pathname);
          return Response.json(remoteDiscovery());
        },
      },
    );

    expect(exit).toBe(CLI_EXIT.usage);
    expect(requests).toEqual(['/v1/health']);
    expect(io.stderrText()).toContain('Remote run requires Git or uploaded workspace preparation');
    expect(io.stderrText()).not.toContain('/private/work');
    expect(io.stderrText()).not.toContain('/implicit/work');
  });

  it('does not fall back to a Local target when Remote negotiation fails', async () => {
    const requests: string[] = [];
    const io = captureIo();
    const exit = await runCli(['sessions', '--remote', 'https://runtime.example.test'], {
      io,
      environment: {
        YANBOT_HARNESS_ACCESS_TOKEN: 'token',
        YANBOT_HARNESS_RUNTIME_DESCRIPTOR: '/must-not-be-read.json',
        YANBOT_HARNESS_RUNTIME_PATH: '/must-not-be-started',
      },
      fetch: async (input) => {
        requests.push(new URL(input instanceof Request ? input.url : input.toString()).pathname);
        throw new Error('offline');
      },
    });

    expect(exit).toBe(CLI_EXIT.runtime);
    expect(requests).toEqual(['/v1/health']);
  });

  it('keeps legacy --runtime restricted to loopback', async () => {
    const io = captureIo();
    const exit = await runCli(['sessions', '--runtime', 'https://runtime.example.test'], {
      io,
      environment: { YANBOT_HARNESS_ACCESS_TOKEN: 'token' },
    });
    expect(exit).toBe(CLI_EXIT.usage);
    expect(io.stderrText()).toContain('legacy Local option');
  });
});

function remoteDiscovery() {
  return {
    service: 'yanbot-harness-remote-runtime',
    protocolVersion: HARNESS_PROTOCOL_VERSION,
    status: 'ok',
    startedAt: '2026-09-17T00:00:00.000Z',
    profile: {
      executionMode: 'remote',
      serviceVersion: '0.1.0-preview.3',
      authentication: 'bearer',
      capabilities: {
        workspaceSources: ['uploaded-snapshot'],
        eventReplay: { durability: 'durable', retentionSeconds: 86_400 },
        interactions: { supported: true, maxWaitSeconds: 3_600 },
      },
    },
  };
}

function captureIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdin: new PassThrough(),
    stdout: { write: (chunk: string | Uint8Array) => (stdout.push(String(chunk)), true) },
    stderr: { write: (chunk: string | Uint8Array) => (stderr.push(String(chunk)), true) },
    stdoutText: () => stdout.join(''),
    stderrText: () => stderr.join(''),
  };
}

async function temporaryProfile(value: unknown): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'yanbot-cli-target-'));
  roots.push(root);
  const file = path.join(root, 'profiles.json');
  await writeFile(file, JSON.stringify(value));
  return file;
}
