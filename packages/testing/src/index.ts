import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  adapterEventSchema,
  adapterSummarySchema,
  createRunResultSchema,
  modelDescriptorSchema,
  runSchema,
  runtimeDiscoverySchema,
  runtimeHealthSchema,
  sessionSchema,
  workspaceGrantSchema,
  type AdapterEvent,
  type AdapterSummary,
  type CreateRunRequest,
  type CreateRunResult,
  type CreateSessionRequest,
  type CreateWorkspaceGrantRequest,
  type InteractionResponse,
  type ModelDescriptor,
  type Run,
  type RuntimeDiscovery,
  type RuntimeHealth,
  type Session,
  type WorkspaceGrant,
} from '@yanbot-harness/contracts';

export * from './runtime-conformance.js';

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
  readonly #routePrefix: '/local' | '/v1';

  constructor(options: { origin: string; accessToken: string; fetch?: typeof fetch; routePrefix?: '/local' | '/v1' }) {
    this.#origin = options.origin.replace(/\/$/, '');
    this.#accessToken = options.accessToken;
    this.#fetch = options.fetch ?? fetch;
    this.#routePrefix = options.routePrefix ?? '/local';
  }

  async health(): Promise<RuntimeHealth | RuntimeDiscovery> {
    const value = await this.#json('GET', '/health');
    return this.#routePrefix === '/v1' ? runtimeDiscoverySchema.parse(value) : runtimeHealthSchema.parse(value);
  }

  async issueWorkspaceGrant(input: CreateWorkspaceGrantRequest): Promise<WorkspaceGrant> {
    return workspaceGrantSchema.parse(await this.#json('POST', '/workspaces/grants', input));
  }

  async createSession(input: CreateSessionRequest): Promise<Session> {
    return sessionSchema.parse(await this.#json('POST', '/sessions', input));
  }

  async listSessions(): Promise<Session[]> {
    return parseArray(await this.#json('GET', '/sessions'), sessionSchema);
  }

  async getSession(sessionId: string): Promise<Session> {
    return sessionSchema.parse(await this.#json('GET', `/sessions/${encodeURIComponent(sessionId)}`));
  }

  async getRun(runId: string): Promise<Run> {
    return runSchema.parse(await this.#json('GET', `/runs/${encodeURIComponent(runId)}`));
  }

  async createRun(sessionId: string, input: CreateRunRequest, idempotencyKey?: string): Promise<CreateRunResult> {
    return createRunResultSchema.parse(
      await this.#json(
        'POST',
        `/sessions/${encodeURIComponent(sessionId)}/runs`,
        input,
        idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey },
      ),
    );
  }

  async cancelRun(runId: string, reason?: string): Promise<Run> {
    return runSchema.parse(
      await this.#json('POST', `/runs/${encodeURIComponent(runId)}/cancel`, {
        ...(reason === undefined ? {} : { reason }),
      }),
    );
  }

  async respond(response: InteractionResponse): Promise<void> {
    await this.#json(
      'POST',
      `/interactions/${encodeURIComponent(response.requestId)}/responses`,
      Object.fromEntries(Object.entries(response).filter(([key]) => key !== 'requestId')),
      {},
      true,
    );
  }

  async listAdapters(): Promise<AdapterSummary[]> {
    return parseArray(await this.#json('GET', '/adapters'), adapterSummarySchema);
  }

  async listModels(adapterId: string): Promise<ModelDescriptor[]> {
    return parseArray(
      await this.#json('GET', `/models?adapterId=${encodeURIComponent(adapterId)}`),
      modelDescriptorSchema,
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
    const response = await this.#fetch(`${this.#origin}${this.#routePrefix}${pathname}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.#accessToken}`,
        ...((init.headers as Record<string, string> | undefined) ?? {}),
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Harness Runtime request failed with HTTP ${response.status}: ${body.slice(0, 2_048)}`);
    }
    return response;
  }

  async *#eventIterator(
    runId: string,
    options: { afterEventId?: string; signal?: AbortSignal },
  ): AsyncGenerator<AdapterEvent> {
    const cursor =
      this.#routePrefix === '/v1' && options.afterEventId !== undefined
        ? `?afterEventId=${encodeURIComponent(options.afterEventId)}`
        : '';
    const response = await this.#request(`/runs/${encodeURIComponent(runId)}/events${cursor}`, {
      headers:
        this.#routePrefix === '/local' && options.afterEventId !== undefined
          ? { 'last-event-id': options.afterEventId }
          : {},
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!response.body) throw new Error('The Harness Runtime returned an empty event stream.');
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

function parseArray<T>(value: unknown, schema: { parse(value: unknown): T }): T[] {
  if (!Array.isArray(value)) throw new Error('The Harness Runtime returned an invalid list.');
  return value.map((entry) => schema.parse(entry));
}
