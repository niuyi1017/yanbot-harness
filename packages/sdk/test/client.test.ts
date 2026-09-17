import { HARNESS_PROTOCOL_VERSION } from '@yanbot-harness/contracts';
import { describe, expect, it } from 'vitest';

import { HarnessClient, HarnessSdkError } from '../src/index.js';

const runId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
const eventId = '33333333-3333-4333-8333-333333333333';

describe('HarnessClient transport', () => {
  it('negotiates a remote target once and uses neutral routes with refreshed bearer tokens', async () => {
    const requests: Array<{ authorization: string | null; pathname: string }> = [];
    let tokenCalls = 0;
    const client = await HarnessClient.connect({
      mode: 'remote',
      origin: 'https://runtime.example.test',
      tokenProvider: async () => ({ accessToken: `token-${++tokenCalls}` }),
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        const headers = new Headers(init?.headers);
        requests.push({ authorization: headers.get('authorization'), pathname: url.pathname });
        if (url.pathname === '/v1/health') return Response.json(remoteDiscovery());
        if (url.pathname === '/v1/sessions') return Response.json([]);
        return Response.json({ unexpected: url.pathname }, { status: 500 });
      },
    });

    expect(client.profile().profile.executionMode).toBe('remote');
    await expect(client.listSessions()).resolves.toEqual([]);
    expect(requests).toEqual([
      { pathname: '/v1/health', authorization: 'Bearer token-1' },
      { pathname: '/v1/sessions', authorization: 'Bearer token-2' },
    ]);
  });

  it('blocks incompatible protocol majors after the explicit health request without probing resources', async () => {
    const paths: string[] = [];
    const error = await HarnessClient.connect({
      mode: 'remote',
      origin: 'https://runtime.example.test',
      tokenProvider: async () => ({ accessToken: 'secret' }),
      fetch: async (input) => {
        paths.push(new URL(input instanceof Request ? input.url : input.toString()).pathname);
        return Response.json({ ...remoteDiscovery(), protocolVersion: '2.0.0' });
      },
    }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(HarnessSdkError);
    expect(error).toMatchObject({ kind: 'protocol' });
    expect(String(error)).toContain('2.0.0');
    expect(paths).toEqual(['/v1/health']);
  });

  it('rejects insecure remote origins before invoking the token provider or fetch', async () => {
    let called = false;
    await expect(
      HarnessClient.connect({
        mode: 'remote',
        origin: 'http://runtime.example.test',
        tokenProvider: async () => {
          called = true;
          return { accessToken: 'secret' };
        },
        fetch: async () => {
          called = true;
          return Response.json(remoteDiscovery());
        },
      }),
    ).rejects.toMatchObject({ kind: 'request' });
    expect(called).toBe(false);
  });

  it('parses chunked CRLF SSE records and ignores heartbeat comments', async () => {
    const payload = JSON.stringify({
      protocolVersion: HARNESS_PROTOCOL_VERSION,
      eventId,
      runId,
      sessionId,
      sequence: 1,
      timestamp: '2026-09-08T00:00:00.000Z',
      type: 'run.completed',
      payload: {},
    });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const bytes = new TextEncoder().encode(`: heartbeat\r\n\r\ndata: ${payload}\r\n\r\n`);
        controller.enqueue(bytes.slice(0, 17));
        controller.enqueue(bytes.slice(17));
        controller.close();
      },
    });
    const client = new HarnessClient({
      origin: 'http://127.0.0.1:1234',
      accessToken: 'secret-value',
      fetch: async () => new Response(stream, { status: 200 }) as Response,
    });

    const events = [];
    for await (const event of client.events(runId, { afterEventId: eventId })) events.push(event);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'run.completed', runId });
  });

  it('maps public errors without exposing non-protocol response bodies or tokens', async () => {
    const client = new HarnessClient({
      origin: 'http://127.0.0.1:1234',
      accessToken: 'super-secret-token',
      fetch: async () => new Response('super-secret-token upstream dump', { status: 500 }),
    });

    const error = await client.listSessions().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(HarnessSdkError);
    expect(String(error)).not.toContain('super-secret-token');
    expect(String(error)).not.toContain('upstream dump');
  });

  it('rejects schema-invalid successful responses', async () => {
    const client = new HarnessClient({
      origin: 'http://127.0.0.1:1234',
      accessToken: 'secret',
      fetch: async () => Response.json([{ vendorSession: true }]),
    });
    await expect(client.listSessions()).rejects.toMatchObject({ kind: 'protocol' });
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
