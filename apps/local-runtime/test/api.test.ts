import { createServer, request as httpRequest, type Server } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ReferenceAdapter, type ReferenceScenario } from '@yanbot-harness/adapter-reference';
import type { AdapterEvent } from '@yanbot-harness/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { LocalAdapterService } from '../src/adapters.js';
import { createLocalRuntimeApp } from '../src/app.js';
import { LocalAuthManager } from '../src/auth.js';
import { LocalEventHub } from '../src/event-hub.js';
import { FileLocalStateStore } from '../src/local-state-store.js';
import { RunSupervisor } from '../src/run-supervisor.js';
import { WorkspaceGrantRegistry } from '../src/workspace-grants.js';

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('local runtime API', () => {
  it('keeps health minimal and protects local routes', async () => {
    const fixture = await setup();
    const health = await fetch(`${fixture.baseUrl}/local/health`);
    expect(health.status).toBe(200);
    const healthBody = await health.json();
    expect(healthBody).toEqual({
      service: 'yanbot-harness-local-runtime',
      protocolVersion: '1.0.0',
      status: 'ok',
      startedAt: '2026-09-07T10:00:00.000Z',
    });
    expect(JSON.stringify(healthBody)).not.toContain('access-secret');
    expect(JSON.stringify(healthBody)).not.toContain(fixture.root);

    const unauthorized = await fetch(`${fixture.baseUrl}/local/sessions`);
    expect(unauthorized.status).toBe(401);
    await expect(unauthorized.json()).resolves.toMatchObject({
      error: { code: 'AUTHENTICATION_FAILED' },
      requestId: expect.any(String),
    });

    expect(await requestStatusWithHost(`${fixture.baseUrl}/local/health`, 'evil.example')).toBe(403);

    const unknownField = await fixture.request('/local/sessions', {
      method: 'POST',
      body: JSON.stringify({ adapterId: 'cn.yanbot.reference', vendorOption: true }),
    });
    expect(unknownField.status).toBe(400);
  });

  it('restricts workspace grants to bearer clients after browser exchange', async () => {
    const fixture = await setup();
    const binding = fixture.auth.issueBrowserBinding(fixture.baseUrl);
    const exchange = await fetch(`${fixture.baseUrl}/local/auth/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: fixture.baseUrl },
      body: JSON.stringify({ token: binding.token }),
    });
    expect(exchange.status).toBe(200);
    const cookie = exchange.headers.get('set-cookie');
    expect(cookie).toContain('HttpOnly');

    const browserRead = await fetch(`${fixture.baseUrl}/local/sessions`, {
      headers: { cookie: cookie!, origin: fixture.baseUrl },
    });
    expect(browserRead.status).toBe(200);
    const wrongOrigin = await fetch(`${fixture.baseUrl}/local/sessions`, {
      headers: { cookie: cookie!, origin: 'http://localhost:9999' },
    });
    expect(wrongOrigin.status).toBe(403);

    const forbidden = await fetch(`${fixture.baseUrl}/local/workspaces/grants`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookie!, origin: fixture.baseUrl },
      body: JSON.stringify({ path: fixture.workspace }),
    });
    expect(forbidden.status).toBe(403);

    const granted = await fixture.request('/local/workspaces/grants', {
      method: 'POST',
      body: JSON.stringify({ path: fixture.workspace }),
    });
    expect(granted.status).toBe(201);
    await expect(granted.json()).resolves.toMatchObject({
      grant: expect.any(String),
      workspaceRef: expect.any(String),
    });
  });

  it('runs through HTTP, streams replayable SSE, and exposes adapter-neutral discovery', async () => {
    const fixture = await setup();
    const grantResponse = await fixture.request('/local/workspaces/grants', {
      method: 'POST',
      body: JSON.stringify({ path: fixture.workspace }),
    });
    const grant = (await grantResponse.json()) as { grant: string };
    const sessionResponse = await fixture.request('/local/sessions', {
      method: 'POST',
      body: JSON.stringify({ adapterId: 'cn.yanbot.reference', title: 'API session' }),
    });
    const session = (await sessionResponse.json()) as { sessionId: string };
    const runResponse = await fixture.request(`/local/sessions/${session.sessionId}/runs`, {
      method: 'POST',
      headers: { 'idempotency-key': 'api-run' },
      body: JSON.stringify({ prompt: 'Hello from API', workspaceGrant: grant.grant }),
    });
    expect(runResponse.status).toBe(202);
    const created = (await runResponse.json()) as { run: { runId: string }; reused: boolean };
    expect(created.reused).toBe(false);

    const stream = await fixture.request(`/local/runs/${created.run.runId}/events`);
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    const events = parseSse(await stream.text());
    expect(events.map((event) => event.type)).toEqual([
      'run.started',
      'session.initialized',
      'assistant.delta',
      'assistant.message',
      'usage.updated',
      'run.completed',
    ]);

    const replay = await fixture.request(`/local/runs/${created.run.runId}/events`, {
      headers: { 'last-event-id': events[0]!.eventId },
    });
    expect(parseSse(await replay.text())).toHaveLength(events.length - 1);
    await expect((await fixture.request(`/local/runs/${created.run.runId}`)).json()).resolves.toMatchObject({
      status: 'completed',
    });

    const adapters = await (await fixture.request('/local/adapters')).json();
    expect(adapters).toMatchObject([{ manifest: { adapterId: 'cn.yanbot.reference' } }]);
    const models = await (await fixture.request('/local/models?adapterId=cn.yanbot.reference')).json();
    expect(models).toMatchObject([{ ref: { modelId: 'deterministic' } }]);
    const summary = await (await fixture.request('/local/config/effective?scopes=user')).json();
    expect(summary).toMatchObject({ scopes: ['user', 'enforced'], credentialKeys: ['API_KEY'] });
    expect(JSON.stringify(summary)).not.toContain('CODEBUDDY_API_KEY');
  });

  it('cancels an active run through the authenticated API', async () => {
    const fixture = await setup({ kind: 'wait-for-cancel' });
    const grant = (await (
      await fixture.request('/local/workspaces/grants', {
        method: 'POST',
        body: JSON.stringify({ path: fixture.workspace }),
      })
    ).json()) as { grant: string };
    const session = (await (
      await fixture.request('/local/sessions', {
        method: 'POST',
        body: JSON.stringify({ adapterId: 'cn.yanbot.reference' }),
      })
    ).json()) as { sessionId: string };
    const created = (await (
      await fixture.request(`/local/sessions/${session.sessionId}/runs`, {
        method: 'POST',
        body: JSON.stringify({ prompt: 'Wait', workspaceGrant: grant.grant }),
      })
    ).json()) as { run: { runId: string } };

    const cancelled = await fixture.request(`/local/runs/${created.run.runId}/cancel`, {
      method: 'POST',
      body: '{}',
    });
    expect(cancelled.status).toBe(200);
    const events = parseSse(await (await fixture.request(`/local/runs/${created.run.runId}/events`)).text());
    expect(events.at(-1)?.type).toBe('run.cancelled');
  });
});

async function setup(scenario: ReferenceScenario = { kind: 'text', chunks: ['ok'] }) {
  const root = await mkdtemp(path.join(tmpdir(), 'yanbot-harness-api-'));
  roots.push(root);
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace);
  const store = new FileLocalStateStore({ stateRoot: path.join(root, 'state') });
  await store.initialize();
  const grants = new WorkspaceGrantRegistry();
  const auth = new LocalAuthManager({ accessToken: 'access-secret', allowedOrigins: [] });
  const supervisor = new RunSupervisor({
    store,
    eventHub: new LocalEventHub(store),
    adapters: new LocalAdapterService({
      adapters: [new ReferenceAdapter({ scenario })],
    }),
    workspaceGrants: grants,
    configLayers: [
      { scope: 'user', sourceRef: 'user:test', values: { adapter: { mode: 'safe' } } },
      {
        scope: 'enforced',
        sourceRef: 'enforced:test',
        values: { credentialRefs: { API_KEY: 'env:CODEBUDDY_API_KEY' } },
      },
    ],
  });
  const app = createLocalRuntimeApp({
    auth,
    workspaceGrants: grants,
    supervisor,
    startedAt: new Date('2026-09-07T10:00:00.000Z'),
    sseHeartbeatMs: 50,
  });
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP server address.');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    root,
    workspace,
    auth,
    baseUrl,
    request: (pathname: string, init: RequestInit = {}) =>
      fetch(`${baseUrl}${pathname}`, {
        ...init,
        headers: {
          authorization: 'Bearer access-secret',
          ...((init.headers as Record<string, string> | undefined) ?? {}),
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
      }),
  };
}

function parseSse(value: string): AdapterEvent[] {
  return value.split('\n\n').flatMap((record) => {
    const data = record
      .split('\n')
      .find((line) => line.startsWith('data: '))
      ?.slice(6);
    return data === undefined ? [] : [JSON.parse(data) as AdapterEvent];
  });
}

async function requestStatusWithHost(url: string, host: string): Promise<number | undefined> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        headers: { host },
      },
      (response) => {
        response.resume();
        response.once('end', () => resolve(response.statusCode));
      },
    );
    request.once('error', reject);
    request.end();
  });
}
