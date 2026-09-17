import {
  HARNESS_PROTOCOL_MAJOR,
  adapterSummarySchema,
  createRunResultSchema,
  effectiveConfigSummarySchema,
  extensionSummarySchema,
  runSchema,
  runtimeDiscoverySchema,
  modelDescriptorSchema,
  runtimeHealthSchema,
  sessionSchema,
  workspaceGrantSchema,
  type AdapterEvent,
  type AdapterSummary,
  type ConfigScope,
  type CreateRunRequest,
  type CreateSessionRequest,
  type CreateWorkspaceGrantRequest,
  type EffectiveConfigSummary,
  type ExtensionSummary,
  type InteractionResponse,
  type Run,
  type RuntimeDiscovery,
  type Session,
  type ModelDescriptor,
  type RuntimeHealth,
  type WorkspaceGrant,
} from '@yanbot-harness/contracts';

import { readRuntimeDescriptor } from './daemon.js';
import { HttpTransport, HarnessSdkError, type Schema, type TransportAccessTokenProvider } from './transport.js';
import type { ManagedRuntimeHandle, StartManagedRuntimeOptions } from './managed-runtime.js';

export type HarnessClientOptions = { origin: string; accessToken: string; fetch?: typeof fetch };
export type AccessToken = { accessToken: string; expiresAt?: string };
export type AccessTokenProvider = () => Promise<AccessToken>;
export type LocalDaemonTarget = {
  mode: 'local-daemon';
  descriptorPath?: string;
  environment?: Readonly<Record<string, string | undefined>>;
  fetch?: typeof fetch;
  signal?: AbortSignal;
};
export type LocalManagedTarget = { mode: 'local-managed'; options?: StartManagedRuntimeOptions };
export type RemoteRuntimeTarget = {
  mode: 'remote';
  origin: string;
  tokenProvider: AccessTokenProvider;
  fetch?: typeof fetch;
  signal?: AbortSignal;
};
export type RuntimeTarget = LocalDaemonTarget | LocalManagedTarget | RemoteRuntimeTarget;
export type EventSubscriptionOptions = { afterEventId?: string; signal?: AbortSignal };

export class HarnessClient {
  readonly #transport: HttpTransport;
  readonly #routePrefix: '/local' | '/v1';
  readonly runtime: RuntimeDiscovery | undefined;

  constructor(options: {
    origin: string;
    accessToken?: string;
    routePrefix?: '/local' | '/v1';
    runtime?: RuntimeDiscovery;
    accessTokenProvider?: TransportAccessTokenProvider;
    fetch?: typeof fetch;
  }) {
    this.#transport = new HttpTransport(options);
    this.#routePrefix = options.routePrefix ?? '/local';
    this.runtime = options.runtime;
  }

  static connect(options: HarnessClientOptions): HarnessClient;
  static connect(target: LocalManagedTarget): Promise<ManagedRuntimeHandle>;
  static connect(target: Exclude<RuntimeTarget, LocalManagedTarget>): Promise<HarnessClient>;
  static connect(
    target: HarnessClientOptions | RuntimeTarget,
  ): HarnessClient | Promise<HarnessClient | ManagedRuntimeHandle> {
    if (!('mode' in target)) return new HarnessClient(target);
    if (target.mode === 'local-managed') {
      return import('./managed-runtime.js').then(
        async ({ startManagedRuntime }) => (await startManagedRuntime(target.options)) as ManagedRuntimeHandle,
      );
    }
    return connectTarget(target);
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

  health(options: { signal?: AbortSignal } = {}): Promise<RuntimeHealth | RuntimeDiscovery> {
    if (this.#routePrefix === '/v1') {
      return this.#transport.json('GET', this.#path('/health'), runtimeDiscoverySchema, options);
    }
    return this.#transport.json('GET', this.#path('/health'), runtimeHealthSchema, options);
  }

  profile(): RuntimeDiscovery {
    if (!this.runtime) {
      throw new HarnessSdkError(
        'protocol',
        'This legacy client has no negotiated Runtime profile. Reconnect with a target.',
      );
    }
    return this.runtime;
  }

  grantWorkspace(input: CreateWorkspaceGrantRequest): Promise<WorkspaceGrant> {
    return this.#transport.json('POST', this.#path('/workspaces/grants'), workspaceGrantSchema, { body: input });
  }

  revokeWorkspaceGrant(grantId: string): Promise<void> {
    return this.#transport.empty('DELETE', this.#path(`/workspaces/grants/${encodeURIComponent(grantId)}`));
  }

  createSession(input: CreateSessionRequest): Promise<Session> {
    return this.#transport.json('POST', this.#path('/sessions'), sessionSchema, { body: input });
  }

  listSessions(): Promise<Session[]> {
    return this.#transport.json('GET', this.#path('/sessions'), arraySchema(sessionSchema));
  }

  getSession(sessionId: string): Promise<Session> {
    return this.#transport.json('GET', this.#path(`/sessions/${encodeURIComponent(sessionId)}`), sessionSchema);
  }

  async createRun(
    sessionId: string,
    input: CreateRunRequest,
    options: { idempotencyKey?: string } = {},
  ): Promise<RunHandle> {
    const result = await this.#transport.json(
      'POST',
      this.#path(`/sessions/${encodeURIComponent(sessionId)}/runs`),
      createRunResultSchema,
      {
        body: input,
        headers: options.idempotencyKey === undefined ? {} : { 'idempotency-key': options.idempotencyKey },
      },
    );
    return new RunHandle(this, result.run, result.reused);
  }

  getRun(runId: string): Promise<Run> {
    return this.#transport.json('GET', this.#path(`/runs/${encodeURIComponent(runId)}`), runSchema);
  }

  cancelRun(runId: string, reason?: string): Promise<Run> {
    return this.#transport.json('POST', this.#path(`/runs/${encodeURIComponent(runId)}/cancel`), runSchema, {
      body: reason === undefined ? {} : { reason },
    });
  }

  respondToInteraction(response: InteractionResponse): Promise<void> {
    const { requestId, ...body } = response;
    return this.#transport.empty('POST', this.#path(`/interactions/${encodeURIComponent(requestId)}/responses`), body);
  }

  events(runId: string, options?: EventSubscriptionOptions): AsyncIterable<AdapterEvent> {
    return this.#transport.events(this.#path(`/runs/${encodeURIComponent(runId)}/events`), runId, options);
  }

  listAdapters(): Promise<AdapterSummary[]> {
    return this.#transport.json('GET', this.#path('/adapters'), arraySchema(adapterSummarySchema));
  }

  listModels(adapterId: string): Promise<ModelDescriptor[]> {
    return this.#transport.json(
      'GET',
      this.#path(`/models?adapterId=${encodeURIComponent(adapterId)}`),
      arraySchema(modelDescriptorSchema),
    );
  }

  getEffectiveConfig(scopes: readonly ConfigScope[] = []): Promise<EffectiveConfigSummary> {
    const query = scopes.length === 0 ? '' : `?scopes=${encodeURIComponent(scopes.join(','))}`;
    return this.#transport.json('GET', this.#path(`/config/effective${query}`), effectiveConfigSummarySchema);
  }

  listExtensions(adapterId?: string): Promise<ExtensionSummary[]> {
    const query = adapterId === undefined ? '' : `?adapterId=${encodeURIComponent(adapterId)}`;
    return this.#transport.json('GET', this.#path(`/extensions${query}`), arraySchema(extensionSummarySchema));
  }

  #path(pathname: string): string {
    return `${this.#routePrefix}${pathname}`;
  }
}

export class RunHandle {
  readonly run: Run;
  readonly reused: boolean;
  readonly #client: HarnessClient;

  constructor(client: HarnessClient, run: Run, reused: boolean) {
    this.#client = client;
    this.run = run;
    this.reused = reused;
  }

  events(options?: EventSubscriptionOptions): AsyncIterable<AdapterEvent> {
    return this.#client.events(this.run.runId, options);
  }

  refresh(): Promise<Run> {
    return this.#client.getRun(this.run.runId);
  }

  cancel(reason?: string): Promise<Run> {
    return this.#client.cancelRun(this.run.runId, reason);
  }

  respond(response: InteractionResponse): Promise<void> {
    return this.#client.respondToInteraction(response);
  }
}

async function connectTarget(target: LocalDaemonTarget | RemoteRuntimeTarget): Promise<HarnessClient> {
  const connection =
    target.mode === 'local-daemon'
      ? await localDaemonConnection(target)
      : {
          origin: assertRemoteOrigin(target.origin),
          accessTokenProvider: target.tokenProvider,
          ...(target.fetch === undefined ? {} : { fetch: target.fetch }),
        };
  const discoveryTransport = new HttpTransport(connection);
  const discovery = await discoveryTransport.json('GET', '/v1/health', runtimeDiscoverySchema, {
    ...(target.signal === undefined ? {} : { signal: target.signal }),
  });
  const protocolMajor = Number.parseInt(discovery.protocolVersion.split('.')[0]!, 10);
  if (protocolMajor !== HARNESS_PROTOCOL_MAJOR) {
    throw new HarnessSdkError(
      'protocol',
      `Harness Protocol ${discovery.protocolVersion} is incompatible with client major ${HARNESS_PROTOCOL_MAJOR}.`,
    );
  }
  const expectedMode = target.mode === 'remote' ? 'remote' : 'local';
  if (discovery.profile.executionMode !== expectedMode) {
    throw new HarnessSdkError(
      'protocol',
      `The ${target.mode} target reported ${discovery.profile.executionMode} execution mode.`,
    );
  }
  return new HarnessClient({ ...connection, routePrefix: '/v1', runtime: discovery });
}

async function localDaemonConnection(target: LocalDaemonTarget) {
  const descriptor = await readRuntimeDescriptor(target);
  return {
    origin: descriptor.origin,
    accessToken: descriptor.accessToken,
    ...(target.fetch === undefined ? {} : { fetch: target.fetch }),
  };
}

function assertRemoteOrigin(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch (error) {
    throw new HarnessSdkError('request', 'The remote Runtime origin is invalid.', { cause: error });
  }
  if (url.protocol !== 'https:') {
    throw new HarnessSdkError('request', 'A remote Runtime target must use HTTPS.');
  }
  return origin;
}

function arraySchema<T>(item: Schema<T>): Schema<T[]> {
  return {
    parse(value: unknown): T[] {
      if (!Array.isArray(value)) throw new TypeError('Expected an array response.');
      return value.map((entry) => item.parse(entry));
    },
  };
}
