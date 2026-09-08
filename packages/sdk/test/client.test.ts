import { HARNESS_PROTOCOL_VERSION } from '@yanbot-harness/contracts';
import { describe, expect, it } from 'vitest';

import { HarnessClient, HarnessSdkError } from '../src/index.js';

const runId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
const eventId = '33333333-3333-4333-8333-333333333333';

describe('HarnessClient transport', () => {
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
