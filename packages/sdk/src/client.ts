import {
  adapterSummarySchema,
  createLocalRunResultSchema,
  effectiveConfigSummarySchema,
  extensionSummarySchema,
  localRunSchema,
  localSessionSchema,
  modelDescriptorSchema,
  runtimeHealthSchema,
  workspaceGrantSchema,
  type AdapterEvent,
  type AdapterSummary,
  type ConfigScope,
  type CreateLocalRunRequest,
  type CreateLocalSessionRequest,
  type CreateWorkspaceGrantRequest,
  type EffectiveConfigSummary,
  type ExtensionSummary,
  type InteractionResponse,
  type LocalRun,
  type LocalSession,
  type ModelDescriptor,
  type RuntimeHealth,
  type WorkspaceGrant,
} from '@yanbot-harness/contracts';

import { readRuntimeDescriptor } from './daemon.js';
import { HttpTransport, type Schema } from './transport.js';

export type HarnessClientOptions = { origin: string; accessToken: string; fetch?: typeof fetch };
export type EventSubscriptionOptions = { afterEventId?: string; signal?: AbortSignal };

export class HarnessClient {
  readonly #transport: HttpTransport;

  constructor(options: HarnessClientOptions) {
    this.#transport = new HttpTransport(options);
  }

  static connect(options: HarnessClientOptions): HarnessClient {
    return new HarnessClient(options);
  }

  static fromRuntime(handle: { origin: string; accessToken: string }): HarnessClient {
    return new HarnessClient(handle);
  }

  static async fromDaemon(
    options: {
      descriptorPath?: string;
      environment?: Readonly<Record<string, string | undefined>>;
      fetch?: typeof fetch;
    } = {},
  ): Promise<HarnessClient> {
    const descriptor = await readRuntimeDescriptor(options);
    return new HarnessClient({
      origin: descriptor.origin,
      accessToken: descriptor.accessToken,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  }

  health(): Promise<RuntimeHealth> {
    return this.#transport.json('GET', '/local/health', runtimeHealthSchema);
  }

  grantWorkspace(input: CreateWorkspaceGrantRequest): Promise<WorkspaceGrant> {
    return this.#transport.json('POST', '/local/workspaces/grants', workspaceGrantSchema, { body: input });
  }

  revokeWorkspaceGrant(grantId: string): Promise<void> {
    return this.#transport.empty('DELETE', `/local/workspaces/grants/${encodeURIComponent(grantId)}`);
  }

  createSession(input: CreateLocalSessionRequest): Promise<LocalSession> {
    return this.#transport.json('POST', '/local/sessions', localSessionSchema, { body: input });
  }

  listSessions(): Promise<LocalSession[]> {
    return this.#transport.json('GET', '/local/sessions', arraySchema(localSessionSchema));
  }

  getSession(sessionId: string): Promise<LocalSession> {
    return this.#transport.json('GET', `/local/sessions/${encodeURIComponent(sessionId)}`, localSessionSchema);
  }

  async createRun(
    sessionId: string,
    input: CreateLocalRunRequest,
    options: { idempotencyKey?: string } = {},
  ): Promise<RunHandle> {
    const result = await this.#transport.json(
      'POST',
      `/local/sessions/${encodeURIComponent(sessionId)}/runs`,
      createLocalRunResultSchema,
      {
        body: input,
        headers: options.idempotencyKey === undefined ? {} : { 'idempotency-key': options.idempotencyKey },
      },
    );
    return new RunHandle(this, result.run, result.reused);
  }

  getRun(runId: string): Promise<LocalRun> {
    return this.#transport.json('GET', `/local/runs/${encodeURIComponent(runId)}`, localRunSchema);
  }

  cancelRun(runId: string, reason?: string): Promise<LocalRun> {
    return this.#transport.json('POST', `/local/runs/${encodeURIComponent(runId)}/cancel`, localRunSchema, {
      body: reason === undefined ? {} : { reason },
    });
  }

  respondToInteraction(response: InteractionResponse): Promise<void> {
    const { requestId, ...body } = response;
    return this.#transport.empty('POST', `/local/interactions/${encodeURIComponent(requestId)}/responses`, body);
  }

  events(runId: string, options?: EventSubscriptionOptions): AsyncIterable<AdapterEvent> {
    return this.#transport.events(runId, options);
  }

  listAdapters(): Promise<AdapterSummary[]> {
    return this.#transport.json('GET', '/local/adapters', arraySchema(adapterSummarySchema));
  }

  listModels(adapterId: string): Promise<ModelDescriptor[]> {
    return this.#transport.json(
      'GET',
      `/local/models?adapterId=${encodeURIComponent(adapterId)}`,
      arraySchema(modelDescriptorSchema),
    );
  }

  getEffectiveConfig(scopes: readonly ConfigScope[] = []): Promise<EffectiveConfigSummary> {
    const query = scopes.length === 0 ? '' : `?scopes=${encodeURIComponent(scopes.join(','))}`;
    return this.#transport.json('GET', `/local/config/effective${query}`, effectiveConfigSummarySchema);
  }

  listExtensions(adapterId?: string): Promise<ExtensionSummary[]> {
    const query = adapterId === undefined ? '' : `?adapterId=${encodeURIComponent(adapterId)}`;
    return this.#transport.json('GET', `/local/extensions${query}`, arraySchema(extensionSummarySchema));
  }
}

export class RunHandle {
  readonly run: LocalRun;
  readonly reused: boolean;
  readonly #client: HarnessClient;

  constructor(client: HarnessClient, run: LocalRun, reused: boolean) {
    this.#client = client;
    this.run = run;
    this.reused = reused;
  }

  events(options?: EventSubscriptionOptions): AsyncIterable<AdapterEvent> {
    return this.#client.events(this.run.runId, options);
  }

  refresh(): Promise<LocalRun> {
    return this.#client.getRun(this.run.runId);
  }

  cancel(reason?: string): Promise<LocalRun> {
    return this.#client.cancelRun(this.run.runId, reason);
  }

  respond(response: InteractionResponse): Promise<void> {
    return this.#client.respondToInteraction(response);
  }
}

function arraySchema<T>(item: Schema<T>): Schema<T[]> {
  return {
    parse(value: unknown): T[] {
      if (!Array.isArray(value)) throw new TypeError('Expected an array response.');
      return value.map((entry) => item.parse(entry));
    },
  };
}
