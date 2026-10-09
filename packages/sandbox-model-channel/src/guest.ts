import { CodeBuddyResponse, normalizeCodeBuddyText } from './codebuddy.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import { CHUNK_LIMIT, REQUEST_LIMIT, RESPONSE_LIMIT, responseFrame, TIMEOUT_MS, type SendFrame } from './protocol.js';

export { normalizeAnthropicRequest as normalizeClaudeText } from './wire.js';
import { normalizeAnthropicRequest as normalizeClaudeText } from './wire.js';

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
  converted?: CodeBuddyResponse;
  stream?: boolean;
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
  constructor(
    private readonly send: SendFrame,
    private readonly protocol: 'claude' | 'codebuddy' = 'claude',
  ) {
    this.#server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
      void (async () => {
        if (
          !this.#enabled ||
          this.#closed ||
          request.method !== 'POST' ||
          !(
            this.protocol === 'codebuddy' ? ['/chat/completions'] : ['/v1/messages', '/v1/messages?beta=true']
          ).includes(request.url ?? '') ||
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
          const raw: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const body = this.protocol === 'codebuddy' ? normalizeCodeBuddyText(raw) : normalizeClaudeText(raw);
          if (this.protocol === 'codebuddy') pending.stream = (body as Record<string, unknown>).stream === true;
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
          if (this.protocol === 'codebuddy') {
            if ((frame.contentType === 'text/event-stream') !== pending.stream) throw new Error();
            pending.converted = new CodeBuddyResponse(pending.stream === true);
          }
          pending.started = true;
          pending.response.writeHead(200, { 'content-type': frame.contentType, 'cache-control': 'no-store' });
        } else {
          if (!pending.started) throw new Error();
          if (frame.data !== undefined) {
            const bytes = Buffer.from(frame.data, 'base64');
            pending.bytes += bytes.length;
            if (bytes.length > CHUNK_LIMIT || pending.bytes > RESPONSE_LIMIT) throw new Error();
            const output = pending.converted ? pending.converted.push(bytes) : bytes;
            if (output.length && !pending.response.write(output))
              await once(pending.response, 'drain', { signal: pending.abort.signal });
          }
        }
        if (frame.end && pending.converted) {
          const output = pending.converted.finish();
          if (!pending.response.write(output)) await once(pending.response, 'drain', { signal: pending.abort.signal });
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
