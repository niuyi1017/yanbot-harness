import { Transform, type TransformCallback } from 'node:stream';
import { TextDecoder } from 'node:util';
import {
  CHUNK_LIMIT,
  guestFrame,
  REQUEST_LIMIT,
  RESPONSE_LIMIT,
  TIMEOUT_MS,
  type ModelRequest,
  type SendFrame,
} from './protocol.js';

type ActiveRequest = {
  id: string;
  abort: AbortController;
  ack?: { sequence: number; resolve(): void; reject(): void };
};

/** Filters private model traffic before the public Sidecar parser. One instance belongs to one container. */
export class HostModelChannel extends Transform {
  #buffer = Buffer.alloc(0);
  #active: ActiveRequest | undefined;
  #requests = 0;
  #closed = false;
  constructor(
    private readonly invoke: ModelRequest,
    private readonly send: SendFrame,
  ) {
    super();
  }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    try {
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
      for (;;) {
        const end = this.#buffer.indexOf(10);
        if (end < 0) break;
        if (end > 4 * 1024 * 1024) throw new Error();
        const line = this.#buffer.subarray(0, end);
        this.#buffer = this.#buffer.subarray(end + 1);
        const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line));
        if (
          typeof value === 'object' &&
          value &&
          'method' in value &&
          typeof value.method === 'string' &&
          value.method.startsWith('model.')
        ) {
          if (line.length > REQUEST_LIMIT + 1024) throw new Error();
          this.#handle(guestFrame.parse(value));
        } else this.push(Buffer.concat([line, Buffer.from('\n')]));
      }
      if (this.#buffer.length > 4 * 1024 * 1024) throw new Error();
      done();
    } catch {
      done(new Error('Invalid private model channel frame.'));
    }
  }
  override _flush(done: TransformCallback): void {
    this.close();
    done(this.#buffer.length ? new Error('Truncated private model channel frame.') : undefined);
  }
  override _destroy(error: Error | null, done: (error?: Error | null) => void): void {
    this.close();
    done(error);
  }
  close(): void {
    this.#closed = true;
    this.#active?.abort.abort();
    this.#active?.ack?.reject();
  }
  #handle(frame: ReturnType<typeof guestFrame.parse>): void {
    if (frame.method === 'model.request') {
      if (
        this.#closed ||
        this.#active ||
        ++this.#requests > 8 ||
        Buffer.byteLength(JSON.stringify(frame.body) ?? '') > REQUEST_LIMIT
      )
        throw new Error();
      const active = { id: frame.id, abort: new AbortController() };
      this.#active = active;
      void this.#forward(frame.body, active).catch(() => this.destroy(new Error('Private model channel failed.')));
    } else {
      const active = this.#active;
      if (!active || active.id !== frame.id) throw new Error();
      if (frame.method === 'model.cancel') {
        active.abort.abort();
        active.ack?.reject();
        return;
      }
      if (!active.ack || active.ack.sequence !== frame.sequence) throw new Error();
      active.ack.resolve();
      delete active.ack;
    }
  }
  async #forward(body: unknown, active: ActiveRequest): Promise<void> {
    const signal = AbortSignal.any([active.abort.signal, AbortSignal.timeout(TIMEOUT_MS)]);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const onAbort = () => {
      active.ack?.reject();
      void reader?.cancel().catch(() => undefined);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    let sequence = 0;
    const frame = async (value: object) => {
      signal.throwIfAborted();
      const current = sequence++;
      const ack = new Promise<void>((resolve, reject) => {
        active.ack = { sequence: current, resolve, reject: () => reject(new Error('Model stream ended.')) };
      });
      // Install the waiter before sending; the peer can ACK immediately.
      await Promise.all([this.send({ method: 'model.response', id: active.id, sequence: current, ...value }), ack]);
    };
    try {
      const response = await this.invoke(body, signal);
      reader = response.body?.getReader();
      const contentType = response.headers.get('content-type')?.split(';')[0]?.trim();
      if (response.status !== 200 || !reader || !['application/json', 'text/event-stream'].includes(contentType ?? ''))
        throw new Error();
      await frame({ contentType });
      let total = 0;
      for (;;) {
        signal.throwIfAborted();
        const next = await reader.read();
        if (next.done) break;
        total += next.value.byteLength;
        if (total > RESPONSE_LIMIT) throw new Error();
        for (let offset = 0; offset < next.value.length; offset += CHUNK_LIMIT)
          await frame({ data: Buffer.from(next.value.subarray(offset, offset + CHUNK_LIMIT)).toString('base64') });
      }
      await frame({ end: true });
    } catch {
      if (!signal.aborted) await frame({ failed: true });
      else
        await this.send({ method: 'model.response', id: active.id, sequence: sequence++, failed: true }).catch(
          () => undefined,
        );
    } finally {
      signal.removeEventListener('abort', onAbort);
      active.abort.abort();
      await reader?.cancel().catch(() => undefined);
      if (this.#active === active) this.#active = undefined;
    }
  }
}
