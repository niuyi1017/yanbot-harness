import { CloudError } from '../common/cloud-error.js';

export const MODEL_TRANSPORT = Symbol('MODEL_TRANSPORT');
export type ModelTransport = typeof fetch;
export type ModelStream = { contentType: string; body: AsyncIterable<Uint8Array>; signal: AbortSignal; close(): void };

export class SecretFilter {
  #pending = Buffer.alloc(0);
  readonly #secrets: Buffer[];
  readonly #tail: number;
  constructor(secrets: readonly string[]) {
    this.#secrets = [...new Set(secrets.filter(Boolean))].map((value) => Buffer.from(value));
    this.#tail = Math.max(1, ...this.#secrets.map((value) => value.length)) - 1;
  }
  push(chunk: Uint8Array, final = false): Buffer {
    const data = Buffer.concat([this.#pending, chunk]);
    const safeEnd = final ? data.length : Math.max(0, data.length - this.#tail);
    let cursor = 0;
    const parts: Buffer[] = [];
    while (cursor < safeEnd) {
      let match = -1;
      let length = 0;
      for (const secret of this.#secrets) {
        const index = data.indexOf(secret, cursor);
        if (index !== -1 && (match === -1 || index < match || (index === match && secret.length > length))) {
          match = index;
          length = secret.length;
        }
      }
      if (match === -1 || match >= safeEnd) break;
      parts.push(data.subarray(cursor, match), Buffer.from('[REDACTED]'));
      cursor = match + length;
    }
    const end = Math.max(cursor, safeEnd);
    parts.push(data.subarray(cursor, end));
    this.#pending = Buffer.from(data.subarray(end));
    return Buffer.concat(parts);
  }
}

function normalize(error: unknown, signal: AbortSignal): CloudError {
  if (signal.aborted && signal.reason instanceof CloudError) return signal.reason;
  if (error instanceof CloudError) return error;
  return new CloudError(502, 'HARNESS_FAILED', 'The model upstream request failed.', false);
}

export async function forwardModel(options: {
  body: string;
  apiKey: string;
  grant: string;
  signal: AbortSignal;
  authorize(): Promise<unknown>;
  transport: ModelTransport;
  timeoutMs?: number;
  maxResponseBytes?: number;
}): Promise<ModelStream> {
  const abort = new AbortController();
  const signal = AbortSignal.any([abort.signal, options.signal]);
  const timeout = setTimeout(
    () => abort.abort(new CloudError(504, 'RUN_TIMEOUT', 'The model request timed out.')),
    options.timeoutMs ?? 30_000,
  );
  timeout.unref();
  let checking = false;
  const lease = setInterval(() => {
    if (checking) return;
    checking = true;
    void options
      .authorize()
      .catch(() => abort.abort(new CloudError(403, 'PERMISSION_DENIED', 'Model authorization ended.')))
      .finally(() => {
        checking = false;
      });
  }, 1000);
  lease.unref();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const close = () => {
    clearTimeout(timeout);
    clearInterval(lease);
    abort.abort();
    void reader?.cancel().catch(() => undefined);
  };
  try {
    await options.authorize();
    signal.throwIfAborted();
    const response = await options.transport('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': options.apiKey },
      body: options.body,
    });
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    if (
      response.status !== 200 ||
      !response.body ||
      !['application/json', 'text/event-stream'].includes(contentType ?? '')
    ) {
      void response.body?.cancel().catch(() => undefined);
      throw new CloudError(502, 'HARNESS_FAILED', 'The model upstream response was rejected.');
    }
    reader = response.body.getReader();
    const filter = new SecretFilter([options.apiKey, options.grant]);
    async function* body() {
      let size = 0;
      try {
        while (true) {
          signal.throwIfAborted();
          const chunk = await reader!.read();
          signal.throwIfAborted();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > (options.maxResponseBytes ?? 8 * 1024 * 1024))
            throw new CloudError(502, 'HARNESS_FAILED', 'The model response exceeded the service limits.');
          const safe = filter.push(chunk.value);
          if (safe.length) yield safe;
        }
        await options.authorize();
        const safe = filter.push(Buffer.alloc(0), true);
        if (safe.length) yield safe;
      } catch (error) {
        throw normalize(error, signal);
      } finally {
        close();
      }
    }
    return { contentType: contentType!, body: body(), signal, close };
  } catch (error) {
    const safe = normalize(error, signal);
    close();
    throw safe;
  }
}
