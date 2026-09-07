import { randomUUID } from 'node:crypto';

import { HarnessAdapterError } from '@yanbot-harness/adapter-api';
import {
  HARNESS_PROTOCOL_VERSION,
  interactionResponseSchema,
  type AdapterEvent,
  type CreateLocalRunRequest,
  type CreateLocalSessionRequest,
  type ExtensionSelection,
  type HarnessCapabilities,
  type HarnessError,
  type InteractionResponse,
  type LocalRun,
  type LocalSession,
  type RunRequest,
  harnessErrorSchema,
} from '@yanbot-harness/contracts';
import {
  assertNoInlineCredentialValues,
  resolveConfigLayers,
  validateAdapterConfig,
  type ConfigLayer,
  type EffectiveConfig,
} from '@yanbot-harness/config-loader';
import { resolveExtensions, type DiscoveredExtension } from '@yanbot-harness/extension-kit';
import type { ManagedRunController } from '@yanbot-harness/core';
import { decidePermission } from '@yanbot-harness/permission-engine';

import type { LocalAdapterService } from './adapters.js';
import type { LocalEventHub } from './event-hub.js';
import type { LocalStateStore } from './local-state-store.js';
import type { WorkspaceGrantRegistry } from './workspace-grants.js';

const DEFAULT_MAX_CONCURRENT_RUNS = 4;
const DEFAULT_RUN_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_INTERACTION_TIMEOUT_MS = 5 * 60_000;
const terminalTypes = new Set<AdapterEvent['type']>(['run.completed', 'run.failed', 'run.cancelled']);

type ActiveRun = {
  runId: string;
  sessionId: string;
  controller?: ManagedRunController;
  cancelReason?: string;
  runTimer: ReturnType<typeof setTimeout>;
  interactionTimers: Map<string, ReturnType<typeof setTimeout>>;
};

type PendingInteraction = { runId: string; sessionId: string };
type RecordedResponse = { serialized: string; operation: Promise<void> };

export type RunSupervisorOptions = {
  store: LocalStateStore;
  eventHub: LocalEventHub;
  adapters: LocalAdapterService;
  workspaceGrants: WorkspaceGrantRegistry;
  configLayers?: readonly ConfigLayer[];
  extensions?: readonly DiscoveredExtension[];
  maxConcurrentRuns?: number;
  runTimeoutMs?: number;
  interactionTimeoutMs?: number;
  now?: () => Date;
  generateId?: () => string;
};

export class RunSupervisorError extends Error {
  readonly status: number;
  readonly error: HarnessError;

  constructor(status: number, error: HarnessError, options?: ErrorOptions) {
    super(error.message, options);
    this.name = 'RunSupervisorError';
    this.status = status;
    this.error = error;
  }
}

export class RunSupervisor {
  readonly #store: LocalStateStore;
  readonly #eventHub: LocalEventHub;
  readonly #adapters: LocalAdapterService;
  readonly #workspaceGrants: WorkspaceGrantRegistry;
  readonly #configLayers: readonly ConfigLayer[];
  readonly #extensions: readonly DiscoveredExtension[];
  readonly #maxConcurrentRuns: number;
  readonly #runTimeoutMs: number;
  readonly #interactionTimeoutMs: number;
  readonly #now: () => Date;
  readonly #generateId: () => string;
  readonly #activeRuns = new Map<string, ActiveRun>();
  readonly #activeSessionRuns = new Map<string, string>();
  readonly #pendingInteractions = new Map<string, PendingInteraction>();
  readonly #responses = new Map<string, RecordedResponse>();
  readonly #idempotency = new Map<string, { fingerprint: string; runId: string }>();
  readonly #idleWaiters = new Set<() => void>();
  #createQueue = Promise.resolve();
  #acceptingRuns = true;

  constructor(options: RunSupervisorOptions) {
    this.#store = options.store;
    this.#eventHub = options.eventHub;
    this.#adapters = options.adapters;
    this.#workspaceGrants = options.workspaceGrants;
    this.#configLayers = options.configLayers ?? [];
    this.#extensions = options.extensions ?? [];
    this.#maxConcurrentRuns = positiveInteger(options.maxConcurrentRuns, DEFAULT_MAX_CONCURRENT_RUNS);
    this.#runTimeoutMs = positiveInteger(options.runTimeoutMs, DEFAULT_RUN_TIMEOUT_MS);
    this.#interactionTimeoutMs = positiveInteger(options.interactionTimeoutMs, DEFAULT_INTERACTION_TIMEOUT_MS);
    this.#now = options.now ?? (() => new Date());
    this.#generateId = options.generateId ?? randomUUID;
  }

  async createSession(input: CreateLocalSessionRequest): Promise<LocalSession> {
    this.#adapters.manifest(input.adapterId);
    const timestamp = this.#now().toISOString();
    const session: LocalSession = {
      protocolVersion: HARNESS_PROTOCOL_VERSION,
      sessionId: this.#generateId(),
      adapterId: input.adapterId,
      ...(input.title === undefined ? {} : { title: input.title }),
      status: 'idle',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.#store.createSession(session);
    return session;
  }

  listSessions(): Promise<LocalSession[]> {
    return this.#store.listSessions();
  }

  async getSession(sessionId: string): Promise<LocalSession> {
    const session = await this.#store.getSession(sessionId);
    if (!session) throw notFound('The local session does not exist.');
    return session;
  }

  async getRun(runId: string): Promise<LocalRun> {
    const run = await this.#store.getRun(runId);
    if (!run) throw notFound('The local run does not exist.');
    return run;
  }

  async createRun(
    sessionId: string,
    input: CreateLocalRunRequest,
    idempotencyKey?: string,
  ): Promise<{ run: LocalRun; reused: boolean }> {
    return this.#serializeCreate(async () => {
      const fingerprint = stableSerialize(input);
      const idempotencyRef = idempotencyKey === undefined ? undefined : `${sessionId}:${idempotencyKey}`;
      const previous = idempotencyRef === undefined ? undefined : this.#idempotency.get(idempotencyRef);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw conflict('The idempotency key was used with another request.');
        return { run: await this.getRun(previous.runId), reused: true };
      }
      if (!this.#acceptingRuns) throw unavailable('The local runtime is shutting down.');
      if (this.#activeSessionRuns.has(sessionId)) throw conflict('The session already has an active run.');
      if (this.#activeRuns.size >= this.#maxConcurrentRuns) throw rateLimited('The local run limit has been reached.');

      const session = await this.getSession(sessionId);
      if (input.model && input.model.adapterId !== session.adapterId) {
        throw new RunSupervisorError(400, {
          code: 'CONFIGURATION_INVALID',
          message: 'The selected model belongs to another adapter.',
          retryable: false,
        });
      }
      for (const selection of input.extensions) {
        if (selection.config) assertNoInlineCredentialValues(selection.config);
      }
      const workspace = await this.#workspaceGrants.resolve(input.workspaceGrant, input.relativeCwd);
      const effectiveConfig = this.effectiveConfig(input.configScopes);
      validateAdapterConfig(effectiveConfig.adapterConfig, this.#adapters.manifest(session.adapterId).configSchema);
      const capabilities = await this.#adapters.capabilities(session.adapterId, effectiveConfig);
      const adapterSessionId = this.#resolveResumeSession(input, session, capabilities);
      const extensionSelections = mergeExtensionSelections(effectiveConfig.extensionSelections, input.extensions);
      resolveExtensions(extensionSelections, this.#extensions, capabilities);

      const timestamp = this.#now().toISOString();
      const run: LocalRun = {
        protocolVersion: HARNESS_PROTOCOL_VERSION,
        runId: this.#generateId(),
        sessionId,
        adapterId: session.adapterId,
        status: 'queued',
        prompt: input.prompt,
        ...(input.model === undefined ? {} : { model: input.model }),
        permissionPolicy: input.permissionPolicy,
        ...(adapterSessionId === undefined ? {} : { adapterSessionId }),
        createdAt: timestamp,
      };
      await this.#store.createRun(run);
      await this.#store.updateSession({
        ...session,
        status: 'running',
        lastRunId: run.runId,
        workspaceRef: workspace.workspaceRef,
        updatedAt: timestamp,
      });

      const active: ActiveRun = {
        runId: run.runId,
        sessionId,
        runTimer: this.#runTimer(run.runId),
        interactionTimers: new Map(),
      };
      this.#activeRuns.set(run.runId, active);
      this.#activeSessionRuns.set(sessionId, run.runId);
      if (idempotencyRef !== undefined) this.#idempotency.set(idempotencyRef, { fingerprint, runId: run.runId });

      const request: RunRequest = {
        runId: run.runId,
        sessionId,
        ...(adapterSessionId === undefined ? {} : { adapterSessionId }),
        prompt: input.prompt,
        cwd: workspace.path,
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.maxTurns === undefined ? {} : { maxTurns: input.maxTurns }),
        permissionPolicy: input.permissionPolicy,
        configScopes: input.configScopes,
        extensions: extensionSelections,
      };
      void this.#execute(run, request, effectiveConfig, active).catch(() => undefined);
      return { run, reused: false };
    });
  }

  async cancelRun(runId: string, reason?: string): Promise<LocalRun> {
    const run = await this.getRun(runId);
    if (isTerminalRun(run)) return run;
    const active = this.#activeRuns.get(runId);
    if (!active) throw conflict('The run is not active in this runtime process.');
    active.cancelReason ??= reason ?? 'Run cancelled by the client.';
    if (active.controller) await active.controller.cancel(active.cancelReason);
    return this.getRun(runId);
  }

  async respondToInteraction(response: InteractionResponse): Promise<void> {
    const parsed = interactionResponseSchema.parse(response);
    const serialized = JSON.stringify(parsed);
    const previous = this.#responses.get(parsed.requestId);
    if (previous) {
      if (previous.serialized !== serialized) throw conflict('The interaction already has a different response.');
      return previous.operation;
    }
    const pending = this.#pendingInteractions.get(parsed.requestId);
    const active = pending ? this.#activeRuns.get(pending.runId) : undefined;
    if (!pending || !active?.controller) throw conflict('The interaction is no longer pending.');
    const operation = active.controller.respond(parsed);
    this.#responses.set(parsed.requestId, { serialized, operation });
    try {
      await operation;
    } catch (error) {
      if (this.#responses.get(parsed.requestId)?.operation === operation) this.#responses.delete(parsed.requestId);
      throw error;
    }
  }

  events(runId: string, afterEventId?: string, signal?: AbortSignal): AsyncIterable<AdapterEvent> {
    return this.#eventHub.subscribe(runId, afterEventId, signal === undefined ? {} : { signal });
  }

  async validateEventCursor(runId: string, afterEventId?: string): Promise<void> {
    await this.getRun(runId);
    await this.#store.readEvents(runId, afterEventId);
  }

  effectiveConfig(scopes: CreateLocalRunRequest['configScopes']): EffectiveConfig {
    return resolveConfigLayers(this.#configLayers, scopes);
  }

  listAdapters() {
    return this.#adapters.list(this.effectiveConfig([]));
  }

  listModels(adapterId: string) {
    return this.#adapters.listModels(adapterId, this.effectiveConfig([]));
  }

  async listExtensions(adapterId?: string): Promise<Array<DiscoveredExtension & { supported?: boolean }>> {
    const capabilities =
      adapterId === undefined ? undefined : await this.#adapters.capabilities(adapterId, this.effectiveConfig([]));
    return this.#extensions.map((extension) => ({
      ...extension,
      ...(capabilities === undefined
        ? {}
        : {
            supported: extension.descriptor.requiredCapabilities.every(
              (capability) =>
                capabilities[capability]?.level !== undefined && capabilities[capability]?.level !== 'unsupported',
            ),
          }),
    }));
  }

  async shutdown(reason = 'The local runtime is shutting down.', graceMs = 5_000): Promise<void> {
    this.#acceptingRuns = false;
    for (const active of this.#activeRuns.values()) {
      active.cancelReason ??= reason;
      if (active.controller) void active.controller.cancel(reason).catch(() => undefined);
    }
    if (await this.#waitForIdle(graceMs)) return;
    for (const active of this.#activeRuns.values()) {
      if (active.controller) void active.controller.dispose().catch(() => undefined);
    }
    await this.#waitForIdle(graceMs);
  }

  #resolveResumeSession(
    input: CreateLocalRunRequest,
    session: LocalSession,
    capabilities: HarnessCapabilities,
  ): string | undefined {
    if (!input.resume) return undefined;
    if (!session.adapterSessionId) throw conflict('The session has no adapter session to resume.');
    const level = capabilities['sessions.resume']?.level;
    if (!level || level === 'unsupported') {
      throw new HarnessAdapterError({
        code: 'CAPABILITY_UNSUPPORTED',
        message: `Adapter ${session.adapterId} cannot resume sessions.`,
        retryable: false,
      });
    }
    return session.adapterSessionId;
  }

  async #execute(
    originalRun: LocalRun,
    request: RunRequest,
    configuration: EffectiveConfig,
    active: ActiveRun,
  ): Promise<void> {
    try {
      const controller = await this.#adapters.startRun(originalRun.adapterId, request, configuration);
      active.controller = controller;
      if (active.cancelReason) await controller.cancel(active.cancelReason);
      for await (const event of controller.events) {
        if (event.type === 'interaction.requested')
          await this.#handleInteraction(active, originalRun, controller, event);
        await this.#eventHub.publish(event, async (persisted) => {
          await this.#updateFromEvent(originalRun.runId, persisted);
          if (isTerminalEvent(persisted)) this.#releaseActive(active);
        });
        if (event.type === 'interaction.resolved') this.#clearInteraction(active, event.payload.requestId);
      }
    } catch (error) {
      await this.#finishWithFailure(originalRun, error);
    } finally {
      if (active.controller) await active.controller.dispose().catch(() => undefined);
      this.#releaseActive(active);
    }
  }

  async #handleInteraction(
    active: ActiveRun,
    run: LocalRun,
    controller: ManagedRunController,
    event: Extract<AdapterEvent, { type: 'interaction.requested' }>,
  ): Promise<void> {
    const decision = decidePermission({ policy: run.permissionPolicy, interaction: event.payload });
    if (decision.action !== 'prompt') {
      await controller.respond({
        requestId: event.payload.requestId,
        action: decision.action,
        message: decision.reason,
      });
      return;
    }
    if (this.#pendingInteractions.has(event.payload.requestId)) {
      throw protocolFailure('An interaction request ID is already active.');
    }
    this.#pendingInteractions.set(event.payload.requestId, { runId: run.runId, sessionId: run.sessionId });
    const timer = setTimeout(() => {
      void this.respondToInteraction({
        requestId: event.payload.requestId,
        action: 'deny',
        message: 'The interaction timed out.',
      }).catch(() => undefined);
    }, this.#interactionTimeoutMs);
    timer.unref();
    active.interactionTimers.set(event.payload.requestId, timer);
  }

  async #updateFromEvent(runId: string, event: AdapterEvent): Promise<void> {
    const run = await this.getRun(runId);
    const timestamp = this.#now().toISOString();
    const terminal = isTerminalEvent(event);
    const updatedRun: LocalRun = {
      ...run,
      status: statusFromEvent(event, run.status),
      firstSequence: run.firstSequence ?? event.sequence,
      lastSequence: event.sequence,
      ...(event.type === 'run.started' && run.startedAt === undefined ? { startedAt: event.timestamp } : {}),
      ...(event.type === 'session.initialized' && event.payload.adapterSessionId
        ? { adapterSessionId: event.payload.adapterSessionId }
        : {}),
      ...(terminal ? { terminalEventType: event.type, completedAt: event.timestamp } : {}),
    };
    await this.#store.updateRun(updatedRun);

    const session = await this.getSession(run.sessionId);
    await this.#store.updateSession({
      ...session,
      ...(event.type === 'session.initialized' && event.payload.adapterSessionId
        ? { adapterSessionId: event.payload.adapterSessionId }
        : {}),
      status: terminal ? (event.type === 'run.failed' ? 'failed' : 'idle') : 'running',
      lastRunId: run.runId,
      updatedAt: timestamp,
    });
  }

  async #finishWithFailure(originalRun: LocalRun, cause: unknown): Promise<void> {
    const existing = await this.#store.readEvents(originalRun.runId).catch(() => []);
    const existingTerminal = existing.at(-1);
    if (existingTerminal && isTerminalEvent(existingTerminal)) {
      await this.#updateFromEvent(originalRun.runId, existingTerminal);
      return;
    }
    let sequence = existing.at(-1)?.sequence ?? 0;
    if (sequence === 0) {
      sequence = 1;
      const started = this.#runtimeEvent(originalRun, sequence, 'run.started', {
        adapterId: originalRun.adapterId,
        ...(originalRun.model === undefined ? {} : { model: originalRun.model }),
      });
      await this.#eventHub.publish(started, (persisted) => this.#updateFromEvent(originalRun.runId, persisted));
    }
    const failed = this.#runtimeEvent(originalRun, sequence + 1, 'run.failed', {
      error: safeHarnessError(cause),
    });
    await this.#eventHub.publish(failed, (persisted) => this.#updateFromEvent(originalRun.runId, persisted));
  }

  #runtimeEvent<T extends 'run.started' | 'run.failed'>(
    run: LocalRun,
    sequence: number,
    type: T,
    payload: Extract<AdapterEvent, { type: T }>['payload'],
  ): Extract<AdapterEvent, { type: T }> {
    return {
      protocolVersion: HARNESS_PROTOCOL_VERSION,
      eventId: this.#generateId(),
      runId: run.runId,
      sessionId: run.sessionId,
      sequence,
      timestamp: this.#now().toISOString(),
      type,
      payload,
      adapterMetadata: { source: 'local-runtime' },
    } as Extract<AdapterEvent, { type: T }>;
  }

  #clearInteraction(active: ActiveRun, requestId: string): void {
    const timer = active.interactionTimers.get(requestId);
    if (timer) clearTimeout(timer);
    active.interactionTimers.delete(requestId);
    this.#pendingInteractions.delete(requestId);
  }

  #releaseActive(active: ActiveRun): void {
    clearTimeout(active.runTimer);
    for (const requestId of [...active.interactionTimers.keys()]) this.#clearInteraction(active, requestId);
    this.#activeRuns.delete(active.runId);
    if (this.#activeSessionRuns.get(active.sessionId) === active.runId)
      this.#activeSessionRuns.delete(active.sessionId);
    if (this.#activeRuns.size === 0) {
      for (const resolve of this.#idleWaiters) resolve();
      this.#idleWaiters.clear();
    }
  }

  async #waitForIdle(graceMs: number): Promise<boolean> {
    if (this.#activeRuns.size === 0) return true;
    const timeoutMs = positiveInteger(graceMs, 5_000);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let idleWaiter: (() => void) | undefined;
    const idle = new Promise<true>((resolve) => {
      idleWaiter = () => resolve(true);
      this.#idleWaiters.add(idleWaiter);
    });
    const expired = new Promise<false>((resolve) => {
      timeout = setTimeout(() => resolve(false), timeoutMs);
      timeout.unref();
    });
    const result = await Promise.race([idle, expired]);
    if (timeout) clearTimeout(timeout);
    if (idleWaiter) this.#idleWaiters.delete(idleWaiter);
    return result;
  }

  #runTimer(runId: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      void this.cancelRun(runId, 'The local run timed out.').catch(() => undefined);
    }, this.#runTimeoutMs);
    timer.unref();
    return timer;
  }

  #serializeCreate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#createQueue.then(operation, operation);
    this.#createQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function mergeExtensionSelections(
  lower: readonly ExtensionSelection[],
  higher: readonly ExtensionSelection[],
): ExtensionSelection[] {
  const merged = new Map(lower.map((selection) => [selection.extensionId, selection]));
  for (const selection of higher) merged.set(selection.extensionId, selection);
  return [...merged.values()];
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isInteger(value) || value <= 0 ? fallback : value;
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function isTerminalRun(run: LocalRun): boolean {
  return (
    run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled' || run.status === 'interrupted'
  );
}

function isTerminalEvent(
  event: AdapterEvent,
): event is Extract<AdapterEvent, { type: 'run.completed' | 'run.failed' | 'run.cancelled' }> {
  return terminalTypes.has(event.type);
}

function statusFromEvent(event: AdapterEvent, current: LocalRun['status']): LocalRun['status'] {
  if (event.type === 'run.completed') return 'completed';
  if (event.type === 'run.failed') return 'failed';
  if (event.type === 'run.cancelled') return 'cancelled';
  if (event.type === 'run.started') return 'running';
  return current;
}

function safeHarnessError(error: unknown): HarnessError {
  if (error instanceof RunSupervisorError) return error.error;
  if (error instanceof HarnessAdapterError) return error.toHarnessError();
  const parsed = harnessErrorSchema.safeParse(error);
  if (parsed.success) {
    return { ...parsed.data, message: safeMessage(parsed.data.message) };
  }
  return { code: 'INTERNAL_ERROR', message: 'The local run failed.', retryable: false };
}

function safeMessage(message: string): string {
  return message.length > 2_048 ? `${message.slice(0, 2_045)}...` : message;
}

function notFound(message: string): RunSupervisorError {
  return new RunSupervisorError(404, { code: 'HARNESS_FAILED', message, retryable: false });
}

function conflict(message: string): RunSupervisorError {
  return new RunSupervisorError(409, { code: 'HARNESS_FAILED', message, retryable: false });
}

function unavailable(message: string): RunSupervisorError {
  return new RunSupervisorError(503, { code: 'ADAPTER_UNAVAILABLE', message, retryable: true });
}

function rateLimited(message: string): RunSupervisorError {
  return new RunSupervisorError(429, { code: 'HARNESS_FAILED', message, retryable: true });
}

function protocolFailure(message: string): HarnessAdapterError {
  return new HarnessAdapterError({ code: 'HARNESS_PROTOCOL_ERROR', message, retryable: false });
}
