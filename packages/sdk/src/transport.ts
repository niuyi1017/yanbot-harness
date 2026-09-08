import {
  adapterEventSchema,
  localApiErrorSchema,
  type AdapterEvent,
  type HarnessError,
} from '@yanbot-harness/contracts';

export type Schema<T> = { parse(value: unknown): T };

export class HarnessSdkError extends Error {
  readonly kind: 'authentication' | 'request' | 'runtime' | 'network' | 'protocol';
  readonly status?: number;
  readonly requestId?: string;
  readonly harnessError?: HarnessError;

  constructor(
    kind: HarnessSdkError['kind'],
    message: string,
    options: ErrorOptions & { status?: number; requestId?: string; harnessError?: HarnessError } = {},
  ) {
    super(message, options);
    this.name = 'HarnessSdkError';
    this.kind = kind;
    if (options.status !== undefined) this.status = options.status;
    if (options.requestId !== undefined) this.requestId = options.requestId;
    if (options.harnessError !== undefined) this.harnessError = options.harnessError;
  }
}

export class HttpTransport {
  readonly #origin: string;
  readonly #accessToken: string;
  readonly #fetch: typeof fetch;

  constructor(options: { origin: string; accessToken: string; fetch?: typeof fetch }) {
    this.#origin = normalizeOrigin(options.origin);
    if (!options.accessToken) throw new HarnessSdkError('authentication', 'A Runtime access token is required.');
    this.#accessToken = options.accessToken;
    this.#fetch = options.fetch ?? fetch;
  }

  async json<T>(
    method: string,
    pathname: string,
    schema: Schema<T>,
    options: { body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<T> {
    const response = await this.request(pathname, {
      method,
      ...(options.headers === undefined ? {} : { headers: options.headers }),
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    let value: unknown;
    try {
      value = await response.json();
    } catch (error) {
      throw new HarnessSdkError('protocol', 'The Runtime returned invalid JSON.', {
        cause: error,
        status: response.status,
      });
    }
    try {
      return schema.parse(value);
    } catch (error) {
      throw new HarnessSdkError('protocol', 'The Runtime response does not match the public protocol.', {
        cause: error,
        status: response.status,
      });
    }
  }

  async empty(method: string, pathname: string, body?: unknown): Promise<void> {
    const response = await this.request(pathname, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status !== 204) {
      throw new HarnessSdkError('protocol', 'The Runtime returned an unexpected response.', {
        status: response.status,
      });
    }
  }

  events(runId: string, options: { afterEventId?: string; signal?: AbortSignal } = {}): AsyncIterable<AdapterEvent> {
    return { [Symbol.asyncIterator]: () => this.eventIterator(runId, options) };
  }

  private async request(pathname: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await this.#fetch(new URL(pathname, `${this.#origin}/`), {
        ...init,
        headers: {
          authorization: `Bearer ${this.#accessToken}`,
          ...((init.headers as Record<string, string> | undefined) ?? {}),
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
      });
    } catch (error) {
      if (error instanceof HarnessSdkError) throw error;
      throw new HarnessSdkError('network', 'Unable to connect to the Harness Runtime.', { cause: error });
    }
    if (!response.ok) await throwResponseError(response);
    return response;
  }

  private async *eventIterator(
    runId: string,
    options: { afterEventId?: string; signal?: AbortSignal },
  ): AsyncGenerator<AdapterEvent> {
    const query = options.afterEventId ? `?afterEventId=${encodeURIComponent(options.afterEventId)}` : '';
    const response = await this.request(`/local/runs/${encodeURIComponent(runId)}/events${query}`, {
      method: 'GET',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!response.body) throw new HarnessSdkError('protocol', 'The Runtime returned an empty event stream.');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const item = await reader.read();
        buffer += decoder.decode(item.value, { stream: !item.done });
        let boundary = /\r?\n\r?\n|\r\r/u.exec(buffer);
        while (boundary?.index !== undefined) {
          const record = buffer.slice(0, boundary.index).replace(/\r\n|\r/gu, '\n');
          buffer = buffer.slice(boundary.index + boundary[0].length);
          const event = parseEventRecord(record, runId);
          if (event) yield event;
          boundary = /\r?\n\r?\n|\r\r/u.exec(buffer);
        }
        if (item.done) {
          if (buffer.trim()) {
            const event = parseEventRecord(buffer.replace(/\r\n|\r/gu, '\n'), runId);
            if (event) yield event;
          }
          break;
        }
      }
    } catch (error) {
      if (options.signal?.aborted) return;
      if (error instanceof HarnessSdkError) throw error;
      throw new HarnessSdkError('network', 'The Runtime event stream ended unexpectedly.', { cause: error });
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }
}

function parseEventRecord(record: string, runId: string): AdapterEvent | undefined {
  const data = record
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /u, ''))
    .join('\n');
  if (!data) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch (error) {
    throw new HarnessSdkError('protocol', 'The Runtime sent invalid event JSON.', { cause: error });
  }
  let event: AdapterEvent;
  try {
    event = adapterEventSchema.parse(value);
  } catch (error) {
    throw new HarnessSdkError('protocol', 'The Runtime sent an invalid event.', { cause: error });
  }
  if (event.runId !== runId) throw new HarnessSdkError('protocol', 'The Runtime event belongs to another run.');
  return event;
}

async function throwResponseError(response: Response): Promise<never> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    value = undefined;
  }
  const parsed = localApiErrorSchema.safeParse(value);
  if (parsed.success) {
    const kind =
      response.status === 401 || parsed.data.error.code === 'AUTHENTICATION_FAILED'
        ? 'authentication'
        : response.status >= 500
          ? 'runtime'
          : 'request';
    throw new HarnessSdkError(kind, parsed.data.error.message, {
      status: response.status,
      requestId: parsed.data.requestId,
      harnessError: parsed.data.error,
    });
  }
  throw new HarnessSdkError(
    response.status === 401 ? 'authentication' : 'runtime',
    `Harness Runtime request failed with HTTP ${response.status}.`,
    {
      status: response.status,
    },
  );
}

function normalizeOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new HarnessSdkError('request', 'The Runtime origin is invalid.', { cause: error });
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new HarnessSdkError('request', 'The Runtime origin is invalid.');
  }
  if (url.pathname !== '/' && url.pathname !== '')
    throw new HarnessSdkError('request', 'The Runtime origin must not contain a path.');
  return url.origin;
}
