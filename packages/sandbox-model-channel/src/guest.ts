import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import { z } from 'zod';
import { CHUNK_LIMIT, REQUEST_LIMIT, RESPONSE_LIMIT, responseFrame, TIMEOUT_MS, type SendFrame } from './protocol.js';

const cache = z.object({ type: z.literal('ephemeral'), ttl: z.enum(['5m', '1h']).optional() }).strict();
const text = z
  .object({ type: z.literal('text'), text: z.string().max(65536), cache_control: cache.optional() })
  .strict();
const content = z.union([z.string().max(65536), z.array(text).max(256)]);
const cliBody = z
  .object({
    model: z.string().min(1).max(256),
    messages: z
      .array(z.object({ role: z.enum(['user', 'assistant']), content }).strict())
      .min(1)
      .max(256),
    system: content.optional(),
    max_tokens: z.number().int().min(1).max(4096),
    stream: z.boolean().optional(),
    temperature: z.number().min(0).max(1).optional(),
    tools: z.array(z.never()).max(0).optional(),
    metadata: z
      .object({ user_id: z.string().max(4096).optional() })
      .strict()
      .optional(),
    thinking: z
      .object({ type: z.literal('disabled') })
      .strict()
      .optional(),
    output_config: z
      .object({ effort: z.enum(['low', 'medium', 'high']).optional() })
      .strict()
      .optional(),
  })
  .strict();
export function normalizeClaudeText(value: unknown): unknown {
  const parsed = cliBody.parse(value);
  const clean = (value: z.infer<typeof content>) =>
    typeof value === 'string' ? value : value.map((v) => ({ type: v.type, text: v.text }));
  return {
    model: parsed.model,
    max_tokens: parsed.max_tokens,
    messages: parsed.messages.map((m) => ({ role: m.role, content: clean(m.content) })),
    ...(parsed.system === undefined ? {} : { system: clean(parsed.system) }),
    ...(parsed.stream === undefined ? {} : { stream: parsed.stream }),
    ...(parsed.temperature === undefined ? {} : { temperature: parsed.temperature }),
  };
}

type Pending = {
  id: string;
  response: ServerResponse;
  abort: AbortController;
  timer: NodeJS.Timeout;
  sequence: number;
  bytes: number;
  started: boolean;
  busy: boolean;
  sent: boolean;
};
/** Loopback is inside the disconnected container, never published on the host. */
export class GuestModelChannel {
  readonly token = randomBytes(32).toString('hex');
  readonly #server;
  #pending: Pending | undefined;
  #enabled = false;
  #closed = false;
  #requests = 0;
  #origin: string | undefined;
  constructor(private readonly send: SendFrame) {
    this.#server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
      void (async () => {
        if (
          !this.#enabled ||
          this.#closed ||
          request.method !== 'POST' ||
          !['/v1/messages', '/v1/messages?beta=true'].includes(request.url ?? '') ||
          request.headers['x-api-key'] !== this.token
        ) {
          response.writeHead(403).end();
          request.resume();
          return;
        }
        if (this.#pending || ++this.#requests > 8) {
          response.writeHead(429).end();
          request.resume();
          return;
        }
        const pending: Pending = {
          id: randomUUID(),
          response,
          abort: new AbortController(),
          sequence: 0,
          bytes: 0,
          started: false,
          busy: false,
          sent: false,
          timer: setTimeout(() => this.cancel(), TIMEOUT_MS),
        };
        this.#pending = pending;
        response.once('close', () => {
          if (this.#pending === pending) this.cancel();
        });
        try {
          let size = 0;
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            size += chunk.length;
            if (size > REQUEST_LIMIT) throw new Error();
            chunks.push(Buffer.from(chunk));
          }
          pending.abort.signal.throwIfAborted();
          const body = normalizeClaudeText(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          pending.sent = true;
          await this.send({ method: 'model.request', id: pending.id, body });
        } catch {
          if (!response.headersSent) response.writeHead(400).end();
          this.cancel();
        }
      })().catch(() => response.destroy());
    });
    this.#server.requestTimeout = TIMEOUT_MS;
    this.#server.headersTimeout = 10_000;
    this.#server.maxConnections = 4;
    this.#server.on('clientError', (_error, socket) => socket.destroy());
  }
  async listen(): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(0, '127.0.0.1', resolve);
    });
    const address = this.#server.address();
    if (!address || typeof address === 'string') throw new Error('Model bridge unavailable.');
    this.#origin = `http://127.0.0.1:${address.port}`;
    return this.#origin;
  }
  setEnabled(enabled: boolean): void {
    this.#enabled = enabled;
    if (!enabled) this.cancel();
  }
  accept(value: unknown): void {
    const frame = responseFrame.parse(value);
    const pending = this.#pending;
    // Late responses after a local disconnect have no consumer.
    if (!pending || pending.id !== frame.id) return;
    if (pending.busy || frame.sequence !== pending.sequence++) throw new Error('Invalid model response order.');
    pending.busy = true;
    void (async () => {
      try {
        if (frame.failed) {
          // Send the ACK before closing the HTTP consumer.
        } else if (frame.contentType) {
          if (pending.started || frame.sequence !== 0) throw new Error();
          pending.started = true;
          pending.response.writeHead(200, { 'content-type': frame.contentType, 'cache-control': 'no-store' });
        } else {
          if (!pending.started) throw new Error();
          if (frame.data !== undefined) {
            const bytes = Buffer.from(frame.data, 'base64');
            pending.bytes += bytes.length;
            if (bytes.length > CHUNK_LIMIT || pending.bytes > RESPONSE_LIMIT) throw new Error();
            if (!pending.response.write(bytes)) await once(pending.response, 'drain', { signal: pending.abort.signal });
          }
        }
        pending.busy = false;
        await this.send({ method: 'model.ack', id: frame.id, sequence: frame.sequence });
        if (frame.end || frame.failed) {
          clearTimeout(pending.timer);
          if (this.#pending === pending) this.#pending = undefined;
          if (frame.failed && pending.started) pending.response.destroy();
          else {
            if (frame.failed) pending.response.writeHead(502);
            pending.response.end();
          }
        }
      } catch {
        this.cancel();
      }
    })();
  }
  cancel(): void {
    const pending = this.#pending;
    if (!pending) return;
    this.#pending = undefined;
    clearTimeout(pending.timer);
    pending.abort.abort();
    pending.response.destroy();
    if (pending.sent) void this.send({ method: 'model.cancel', id: pending.id }).catch(() => undefined);
  }
  async close(): Promise<void> {
    this.#closed = true;
    this.cancel();
    this.#server.closeAllConnections();
    if (this.#server.listening) await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }
}
