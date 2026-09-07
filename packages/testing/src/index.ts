export function createDeterministicIdGenerator(prefix = '00000000-0000-4000-8000-'): () => string {
  let counter = 0;
  return () => `${prefix}${String(++counter).padStart(12, '0')}`;
}

export function createDeterministicClock(start = '2026-01-01T00:00:00.000Z'): () => Date {
  let timestamp = new Date(start).getTime();
  if (!Number.isFinite(timestamp)) throw new TypeError('The deterministic clock requires a valid ISO timestamp.');
  return () => {
    const current = new Date(timestamp);
    timestamp += 1;
    return current;
  };
}

export async function collectAsync<T>(source: AsyncIterable<T>, limit = 1_000): Promise<T[]> {
  const values: T[] = [];
  for await (const value of source) {
    values.push(value);
    if (values.length > limit) throw new Error(`Async iterable exceeded the ${limit} item safety limit.`);
  }
  return values;
}

export class LocalRuntimeTestClient {
  readonly #origin: string;
  readonly #accessToken: string;
  readonly #fetch: typeof fetch;

  constructor(options: { origin: string; accessToken: string; fetch?: typeof fetch }) {
    this.#origin = options.origin.replace(/\/$/, '');
    this.#accessToken = options.accessToken;
    this.#fetch = options.fetch ?? fetch;
  }

  async issueWorkspaceGrant(input: CreateWorkspaceGrantRequest): Promise<WorkspaceGrant> {
    return workspaceGrantSchema.parse(await this.#json('POST', '/local/workspaces/grants', input));
  }

  async createSession(input: CreateLocalSessionRequest): Promise<LocalSession> {
    return localSessionSchema.parse(await this.#json('POST', '/local/sessions', input));
  }

  async listSessions(): Promise<LocalSession[]> {
    const response = await this.#request('/local/sessions');
    const value: unknown = await response.json();
    if (!Array.isArray(value)) throw new Error('The local runtime returned an invalid session list.');
    return value.map((session) => localSessionSchema.parse(session));
  }

  async getRun(runId: string): Promise<LocalRun> {
    return localRunSchema.parse(await this.#json('GET', `/local/runs/${encodeURIComponent(runId)}`));
  }

  async createRun(
    sessionId: string,
    input: CreateLocalRunRequest,
    idempotencyKey?: string,
  ): Promise<{ run: LocalRun; reused: boolean }> {
    const response = (await this.#json(
      'POST',
      `/local/sessions/${encodeURIComponent(sessionId)}/runs`,
      input,
      idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey },
    )) as { run?: unknown; reused?: unknown };
    if (typeof response.reused !== 'boolean') throw new Error('The local runtime returned an invalid run result.');
    return { run: localRunSchema.parse(response.run), reused: response.reused };
  }

  async cancelRun(runId: string, reason?: string): Promise<LocalRun> {
    return localRunSchema.parse(
      await this.#json('POST', `/local/runs/${encodeURIComponent(runId)}/cancel`, {
        ...(reason === undefined ? {} : { reason }),
      }),
    );
  }

  async respond(response: InteractionResponse): Promise<void> {
    await this.#json(
      'POST',
      `/local/interactions/${encodeURIComponent(response.requestId)}/responses`,
      Object.fromEntries(Object.entries(response).filter(([key]) => key !== 'requestId')),
      {},
      true,
    );
  }

  events(runId: string, options: { afterEventId?: string; signal?: AbortSignal } = {}): AsyncIterable<AdapterEvent> {
    return { [Symbol.asyncIterator]: () => this.#eventIterator(runId, options) };
  }

  async #json(
    method: string,
    pathname: string,
    body?: unknown,
    headers: Record<string, string> = {},
    allowEmpty = false,
  ): Promise<unknown> {
    const response = await this.#request(pathname, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (allowEmpty && response.status === 204) return undefined;
    return response.json();
  }

  async #request(pathname: string, init: RequestInit = {}): Promise<Response> {
    const response = await this.#fetch(`${this.#origin}${pathname}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.#accessToken}`,
        ...((init.headers as Record<string, string> | undefined) ?? {}),
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Local runtime request failed with HTTP ${response.status}: ${body.slice(0, 2_048)}`);
    }
    return response;
  }

  async *#eventIterator(
    runId: string,
    options: { afterEventId?: string; signal?: AbortSignal },
  ): AsyncGenerator<AdapterEvent> {
    const response = await this.#request(`/local/runs/${encodeURIComponent(runId)}/events`, {
      headers: options.afterEventId === undefined ? {} : { 'last-event-id': options.afterEventId },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!response.body) throw new Error('The local runtime returned an empty event stream.');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const item = await reader.read();
        buffer += decoder.decode(item.value, { stream: !item.done });
        const records = buffer.split(/\r?\n\r?\n/u);
        buffer = records.pop() ?? '';
        for (const record of records) {
          const data = record
            .split(/\r?\n/u)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');
          if (data) yield adapterEventSchema.parse(JSON.parse(data));
        }
        if (item.done) break;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }
}

export async function createTemporaryStateRoot(prefix = 'yanbot-harness-test-'): Promise<{
  path: string;
  cleanup(): Promise<void>;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  let cleaned = false;
  return {
    path: directory,
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      await rm(directory, { recursive: true, force: true });
    },
  };
}
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  adapterEventSchema,
  localRunSchema,
  localSessionSchema,
  workspaceGrantSchema,
  type AdapterEvent,
  type CreateLocalRunRequest,
  type CreateLocalSessionRequest,
  type CreateWorkspaceGrantRequest,
  type InteractionResponse,
  type LocalRun,
  type LocalSession,
  type WorkspaceGrant,
} from '@yanbot-harness/contracts';
