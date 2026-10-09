import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { GuestModelChannel, HostModelChannel, normalizeClaudeText } from '../src/index.js';

const body = { model: 'claude-sonnet-4-6', max_tokens: 1024, messages: [{ role: 'user', content: 'Hello' }] };
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) await stop();
});
async function pair(invoke: ConstructorParameters<typeof HostModelChannel>[0]) {
  const host = new HostModelChannel(invoke, async (frame) => {
    guest.accept(frame);
  });
  const errors: Error[] = [];
  host.on('error', (error) => errors.push(error));
  host.resume();
  const guest = new GuestModelChannel(
    (frame) =>
      new Promise<void>((resolve, reject) =>
        host.write(`${JSON.stringify(frame)}\n`, (error) => (error ? reject(error) : resolve())),
      ),
  );
  const origin = await guest.listen();
  guest.setEnabled(true);
  cleanup.push(async () => {
    await guest.close();
    host.destroy();
  });
  const request = (value: unknown = body, init: RequestInit = {}, route = '/v1/messages') =>
    fetch(origin + route, {
      method: 'POST',
      headers: { 'x-api-key': guest.token, 'content-type': 'application/json' },
      body: JSON.stringify(value),
      ...init,
    });
  return { request, host, guest, errors };
}
describe('private sandbox model channel', () => {
  it.each(['application/json', 'text/event-stream'])(
    'streams %s across bounded frames with ACKs and preserves UTF8',
    async (contentType) => {
      const text = '你好🌍'.repeat(18000);
      const f = await pair(async (value) => {
        expect(value).toEqual(body);
        return new Response(text, { headers: { 'content-type': contentType } });
      });
      const response = await f.request();
      expect(response.headers.get('content-type')).toBe(contentType);
      expect(await response.text()).toBe(text);
      expect(f.errors).toEqual([]);
      expect(await (await f.request()).text()).toBe(text);
    },
  );
  it('normalizes only known CLI text metadata and rejects capabilities and unknown keys', () => {
    expect(
      normalizeClaudeText({
        ...body,
        tools: [],
        metadata: { user_id: 'private' },
        system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }],
        thinking: { type: 'disabled' },
        output_config: { effort: 'high' },
      }),
    ).toEqual({ ...body, system: [{ type: 'text', text: 'sys' }] });
    for (const extra of [
      { url: 'http://169.254.169.254' },
      { tools: [{ name: 'exec' }] },
      { thinking: { type: 'enabled', budget_tokens: 1024 } },
      { messages: [{ role: 'user', content: [{ type: 'image', source: {} }] }] },
    ])
      expect(() => normalizeClaudeText({ ...body, ...extra })).toThrow();
  });
  it('denies disabled, wrong token, paths, unsupported input and oversized body before forwarding', async () => {
    let calls = 0;
    const f = await pair(async () => {
      calls++;
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    });
    expect((await f.request(body, { headers: {} })).status).toBe(403);
    expect((await f.request(body, {}, '/v1/models')).status).toBe(403);
    expect((await f.request({ ...body, tools: [{}] })).status).toBe(400);
    await f.request({ ...body, system: 'x'.repeat(300000) }).catch(() => undefined);
    f.guest.setEnabled(false);
    expect((await f.request()).status).toBe(403);
    expect(calls).toBe(0);
  });
  it('discards upstream errors and enforces the eight request lifetime cap', async () => {
    const f = await pair(async () => new Response('sensitive-diagnostic', { status: 401 }));
    for (let n = 0; n < 8; n++) {
      const response = await f.request();
      expect(response.status).toBe(502);
      expect(await response.text()).not.toContain('sensitive');
    }
    expect((await f.request()).status).toBe(429);
  });
  it('rejects concurrency and aborts the bound upstream when the HTTP client disconnects', async () => {
    let upstreamSignal: AbortSignal | undefined;
    const f = await pair(async (_body, signal) => {
      upstreamSignal = signal;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: start\n\n'));
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    });
    const abort = new AbortController();
    const first = await f.request(body, { signal: abort.signal });
    expect((await f.request()).status).toBe(429);
    const reader = first.body!.getReader();
    await reader.read();
    abort.abort();
    await expect.poll(() => upstreamSignal?.aborted).toBe(true);
    reader.releaseLock();
  });
  it('does not consume response chunks until the preceding frame has been acknowledged', async () => {
    const frames: unknown[] = [];
    const host = new HostModelChannel(
      async () => new Response('payload', { headers: { 'content-type': 'application/json' } }),
      async (frame) => {
        frames.push(frame);
      },
    );
    host.on('error', () => undefined);
    host.resume();
    cleanup.push(async () => {
      host.destroy();
    });
    const id = randomUUID();
    host.write(JSON.stringify({ method: 'model.request', id, body }) + '\n');
    await expect.poll(() => frames.length).toBe(1);
    expect(frames[0]).toMatchObject({ contentType: 'application/json', sequence: 0 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(frames).toHaveLength(1);
    host.write(JSON.stringify({ method: 'model.ack', id, sequence: 0 }) + '\n');
    await expect.poll(() => frames.length).toBe(2);
    expect(frames[1]).toMatchObject({ data: Buffer.from('payload').toString('base64'), sequence: 1 });
  });
  it.each([
    { method: 'model.request', id: randomUUID(), body, url: 'http://evil' },
    { method: 'model.ack', id: randomUUID(), sequence: 0 },
    { method: 'model.other' },
  ])('fails closed on malformed or unbound frames', async (frame) => {
    const host = new HostModelChannel(
      async () => {
        throw new Error('Must not invoke');
      },
      async () => undefined,
    );
    const error = once(host, 'error');
    host.write(JSON.stringify(frame) + '\n');
    expect((await error)[0].message).toBe('Invalid private model channel frame.');
  });
  it('preserves public Sidecar frames without private traffic', async () => {
    const f = await pair(async () => new Response('{}', { headers: { 'content-type': 'application/json' } }));
    const publicFrames: string[] = [];
    f.host.on('data', (bytes) => publicFrames.push(bytes.toString()));
    const line = JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) + '\n';
    f.host.write(line);
    await (await f.request()).text();
    expect(publicFrames).toEqual([line]);
  });
});
