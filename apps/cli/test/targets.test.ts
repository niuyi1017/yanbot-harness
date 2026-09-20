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
  it('documents profiles, Remote targets, and explicit workspace preparation in help', async () => {
    const io = captureIo();
    await expect(runCli(['--help'], { io })).resolves.toBe(CLI_EXIT.success);
    expect(io.stdoutText()).toContain('--remote HTTPS_URL');
    expect(io.stdoutText()).toContain('--profile NAME');
    expect(io.stdoutText()).toContain('--snapshot PATH');
    expect(io.stdoutText()).toContain('implicit cwd');
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

  it('rejects Remote run without explicit preparation after handshake and never sends a local path', async () => {
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
    expect(io.stderrText()).toContain('Remote run requires --snapshot');
    expect(io.stderrText()).not.toContain('/private/work');
    expect(io.stderrText()).not.toContain('/implicit/work');
  });

  it('prepares immutable Git and uses the returned workspace source for a Remote run', async () => {
    const requests: Array<{ pathname: string; body?: unknown }> = [];
    const io = captureIo();
    const runId = '11111111-1111-4111-8111-111111111111';
    const sessionId = '22222222-2222-4222-8222-222222222222';
    const source = {
      kind: 'git-ref' as const,
      repository: 'https://github.com/example/repo.git',
      ref: 'a'.repeat(40),
    };
    const exit = await runCli(
      [
        'run',
        'remote work',
        '--remote',
        'https://runtime.example.test',
        '--git-repository',
        source.repository,
        '--git-commit',
        source.ref,
        '--json',
      ],
      {
        io,
        environment: { YANBOT_HARNESS_ACCESS_TOKEN: 'token' },
        cwd: '/must-not-leak',
        fetch: async (input, init) => {
          const url = new URL(input instanceof Request ? input.url : input.toString());
          const body = init?.body ? JSON.parse(String(init.body)) : undefined;
          requests.push({ pathname: url.pathname, ...(body === undefined ? {} : { body }) });
          if (url.pathname === '/v1/health') return Response.json(remoteDiscovery(['uploaded-snapshot', 'git-ref']));
          if (url.pathname === '/v1/adapters') return Response.json([adapterSummary()]);
          if (url.pathname === '/v1/sessions') {
            return Response.json({
              protocolVersion: HARNESS_PROTOCOL_VERSION,
              sessionId,
              adapterId: 'cn.yanbot.reference',
              status: 'idle',
              createdAt: '2026-09-20T00:00:00.000Z',
              updatedAt: '2026-09-20T00:00:00.000Z',
            });
          }
          if (url.pathname === '/v1/workspaces/git') {
            return Response.json({
              workspace: source,
              workspaceRef: '44444444-4444-4444-8444-444444444444',
              expiresAt: '2026-09-21T00:00:00.000Z',
            });
          }
          if (url.pathname === `/v1/sessions/${sessionId}/runs`) {
            return Response.json({
              reused: false,
              run: {
                protocolVersion: HARNESS_PROTOCOL_VERSION,
                runId,
                sessionId,
                adapterId: 'cn.yanbot.reference',
                status: 'queued',
                prompt: 'remote work',
                permissionPolicy: 'interactive',
                createdAt: '2026-09-20T00:00:00.000Z',
              },
            });
          }
          if (url.pathname === `/v1/runs/${runId}/events`) {
            const event = {
              protocolVersion: HARNESS_PROTOCOL_VERSION,
              eventId: '33333333-3333-4333-8333-333333333333',
              runId,
              sessionId,
              sequence: 1,
              timestamp: '2026-09-20T00:00:01.000Z',
              type: 'run.completed',
              payload: {},
            };
            return new Response(`data: ${JSON.stringify(event)}\n\n`, {
              headers: { 'content-type': 'text/event-stream' },
            });
          }
          return Response.json({}, { status: 500 });
        },
      },
    );
    expect(exit).toBe(CLI_EXIT.success);
    const runRequest = requests.find((request) => request.pathname.endsWith('/runs'));
    expect(runRequest?.body).toMatchObject({ workspace: source });
    expect(JSON.stringify(requests)).not.toContain('/must-not-leak');
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

function remoteDiscovery(workspaceSources = ['uploaded-snapshot']) {
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
        workspaceSources,
        eventReplay: { durability: 'durable', retentionSeconds: 86_400 },
        interactions: { supported: true, maxWaitSeconds: 3_600 },
      },
    },
  };
}

function adapterSummary() {
  return {
    manifest: {
      protocolVersion: HARNESS_PROTOCOL_VERSION,
      adapterId: 'cn.yanbot.reference',
      adapterVersion: '0.1.0',
      displayName: 'Reference',
      harness: { name: 'Reference', version: '0.1.0' },
      runtimeKinds: ['remote'],
    },
    capabilities: {},
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
