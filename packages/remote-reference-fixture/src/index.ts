import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { HarnessAdapterError, assertRuntimeMatchesCapabilities } from '@yanbot-harness/adapter-api';
import { ReferenceAdapter, type ReferenceScenario } from '@yanbot-harness/adapter-reference';
import {
  HARNESS_PROTOCOL_VERSION,
  HARNESS_RELEASE_VERSION,
  adapterEventSchema,
  adapterIdSchema,
  apiErrorSchema,
  createRunRequestSchema,
  createSessionRequestSchema,
  interactionResponseSchema,
  type AdapterEvent,
  type ApiError,
  type CreateRunRequest,
  type HarnessError,
  type Run,
  type Session,
  type WorkspaceSource,
} from '@yanbot-harness/contracts';
import { createManagedAdapterRun, type ManagedRunController } from '@yanbot-harness/core';

const origin = 'https://remote.reference.test';
const adapterId = 'cn.yanbot.reference';
const terminalTypes = new Set<AdapterEvent['type']>(['run.completed', 'run.failed', 'run.cancelled']);

type Principal = { tenantId: string; subjectId: string };
type TokenRecord = Principal & { expiresAt: number };
type SnapshotRecord = { tenantId: string; uploadId: string; digest: string; workspaceRef: string; cwd: string };
type SessionRecord = { tenantId: string; session: Session };
type RunRecord = {
  tenantId: string;
  run: Run;
  events: AdapterEvent[];
  waiters: Set<() => void>;
  controller?: ManagedRunController;
};
type InteractionRecord = { tenantId: string; runId: string; controller: ManagedRunController };

export type RemoteReferenceFixtureOptions = {
  scenario?: ReferenceScenario;
  now?: () => Date;
  generateId?: () => string;
};

export type RemoteReferenceFixture = {
  readonly origin: typeof origin;
  readonly fetch: typeof fetch;
  issueToken(input: { tenantId: string; subjectId: string; expiresAt?: Date }): string;
  prepareSnapshot(input: {
    tenantId: string;
    digest?: string;
  }): Extract<WorkspaceSource, { kind: 'uploaded-snapshot' }>;
  close(): Promise<void>;
};

export async function createRemoteReferenceFixture(
  options: RemoteReferenceFixtureOptions = {},
): Promise<RemoteReferenceFixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'yanbot-remote-reference-'));
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace);
  return new InMemoryRemoteReferenceFixture(root, workspace, options);
}

class InMemoryRemoteReferenceFixture implements RemoteReferenceFixture {
  readonly origin = origin;
  readonly fetch: typeof fetch;

  readonly #root: string;
  readonly #workspace: string;
  readonly #adapter: ReferenceAdapter;
  readonly #now: () => Date;
  readonly #generateId: () => string;
  readonly #startedAt: string;
  readonly #tokens = new Map<string, TokenRecord>();
  readonly #snapshots = new Map<string, SnapshotRecord>();
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #runs = new Map<string, RunRecord>();
  readonly #interactions = new Map<string, InteractionRecord>();
  readonly #idempotency = new Map<string, { fingerprint: string; runId: string }>();
  #closed = false;

  constructor(root: string, workspace: string, options: RemoteReferenceFixtureOptions) {
    this.#root = root;
    this.#workspace = workspace;
    this.#now = options.now ?? (() => new Date());
    this.#generateId = options.generateId ?? randomUUID;
    this.#startedAt = this.#now().toISOString();
    this.#adapter = new ReferenceAdapter({
      ...(options.scenario === undefined ? {} : { scenario: options.scenario }),
      now: this.#now,
      generateId: this.#generateId,
    });
    this.fetch = async (input, init) => this.#route(new Request(input, init));
  }

  issueToken(input: { tenantId: string; subjectId: string; expiresAt?: Date }): string {
    this.#assertOpen();
    const token = randomBytes(32).toString('base64url');
    this.#tokens.set(tokenDigest(token), {
      tenantId: requiredIdentifier(input.tenantId, 'tenantId'),
      subjectId: requiredIdentifier(input.subjectId, 'subjectId'),
      expiresAt: input.expiresAt?.getTime() ?? this.#now().getTime() + 60 * 60_000,
    });
    return token;
  }

  prepareSnapshot(input: {
    tenantId: string;
    digest?: string;
  }): Extract<WorkspaceSource, { kind: 'uploaded-snapshot' }> {
    this.#assertOpen();
    const tenantId = requiredIdentifier(input.tenantId, 'tenantId');
    const uploadId = this.#generateId();
    const digest = input.digest ?? `sha256:${'0'.repeat(64)}`;
    const source = { kind: 'uploaded-snapshot' as const, uploadId, digest };
    const parsed = createRunRequestSchema.parse({ prompt: 'Fixture validation.', workspace: source });
    if (!('workspace' in parsed) || parsed.workspace.kind !== 'uploaded-snapshot') {
      throw new TypeError('Expected an uploaded snapshot workspace source.');
    }
    this.#snapshots.set(resourceKey(tenantId, uploadId), {
      tenantId,
      uploadId,
      digest,
      workspaceRef: this.#generateId(),
      cwd: this.#workspace,
    });
    return source;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const active = [...this.#runs.values()].flatMap((record) => (record.controller ? [record.controller] : []));
    await Promise.allSettled(active.map((controller) => controller.dispose()));
    for (const record of this.#runs.values()) notify(record);
    await rm(this.#root, { recursive: true, force: true });
  }

  async #route(request: Request): Promise<Response> {
    const requestId = this.#generateId();
    try {
      this.#assertOpen();
      const url = new URL(request.url);
      if (url.origin !== origin || !url.pathname.startsWith('/v1/')) throw notFound('The route does not exist.');
      const principal = this.#authenticate(request);

      if (request.method === 'GET' && url.pathname === '/v1/health') return Response.json(this.#discovery());
      if (request.method === 'GET' && url.pathname === '/v1/adapters') {
        const runtime = await this.#adapter.createRuntime();
        try {
          return Response.json([
            { manifest: this.#adapter.manifest, capabilities: await assertRuntimeMatchesCapabilities(runtime) },
          ]);
        } finally {
          await runtime.dispose();
        }
      }
      if (request.method === 'GET' && url.pathname === '/v1/models') {
        const selectedAdapterId = adapterIdSchema.parse(url.searchParams.get('adapterId'));
        if (selectedAdapterId !== adapterId) throw notFound('The adapter does not exist.');
        const runtime = await this.#adapter.createRuntime();
        try {
          await assertRuntimeMatchesCapabilities(runtime);
          if (!runtime.listModels) throw unsupported('The adapter does not support model discovery.');
          return Response.json(await runtime.listModels());
        } finally {
          await runtime.dispose();
        }
      }
      if (request.method === 'POST' && url.pathname === '/v1/sessions') {
        return Response.json(await this.#createSession(principal, await request.json()), { status: 201 });
      }
      if (request.method === 'GET' && url.pathname === '/v1/sessions') {
        return Response.json(
          [...this.#sessions.values()]
            .filter((record) => record.tenantId === principal.tenantId)
            .map((record) => record.session),
        );
      }

      const sessionMatch = /^\/v1\/sessions\/([^/]+)$/u.exec(url.pathname);
      if (request.method === 'GET' && sessionMatch) {
        return Response.json(this.#session(principal, decodeURIComponent(sessionMatch[1]!)).session);
      }
      const createRunMatch = /^\/v1\/sessions\/([^/]+)\/runs$/u.exec(url.pathname);
      if (request.method === 'POST' && createRunMatch) {
        const result = await this.#createRun(
          principal,
          decodeURIComponent(createRunMatch[1]!),
          await request.json(),
          request.headers.get('idempotency-key') ?? undefined,
        );
        return Response.json(result, { status: 202 });
      }
      const runMatch = /^\/v1\/runs\/([^/]+)$/u.exec(url.pathname);
      if (request.method === 'GET' && runMatch) {
        return Response.json(this.#run(principal, decodeURIComponent(runMatch[1]!)).run);
      }
      const cancelMatch = /^\/v1\/runs\/([^/]+)\/cancel$/u.exec(url.pathname);
      if (request.method === 'POST' && cancelMatch) {
        const body = (await request.json()) as unknown;
        const reason = parseCancelReason(body);
        const record = this.#run(principal, decodeURIComponent(cancelMatch[1]!));
        await record.controller?.cancel(reason);
        return Response.json(record.run);
      }
      const eventMatch = /^\/v1\/runs\/([^/]+)\/events$/u.exec(url.pathname);
      if (request.method === 'GET' && eventMatch) {
        const record = this.#run(principal, decodeURIComponent(eventMatch[1]!));
        return this.#eventResponse(record, url.searchParams.get('afterEventId') ?? undefined);
      }
      const interactionMatch = /^\/v1\/interactions\/([^/]+)\/responses$/u.exec(url.pathname);
      if (request.method === 'POST' && interactionMatch) {
        const requestIdValue = decodeURIComponent(interactionMatch[1]!);
        const interaction = this.#interactions.get(resourceKey(principal.tenantId, requestIdValue));
        if (!interaction) throw conflict('The interaction is no longer pending.');
        const body = await request.json();
        if (!isObject(body)) throw invalid('The interaction response is invalid.');
        const response = interactionResponseSchema.parse({ ...body, requestId: requestIdValue });
        await interaction.controller.respond(response);
        return new Response(null, { status: 204 });
      }
      throw notFound('The route does not exist.');
    } catch (error) {
      return errorResponse(error, requestId);
    }
  }

  #authenticate(request: Request): Principal {
    const authorization = request.headers.get('authorization');
    if (!authorization?.startsWith('Bearer ')) throw authenticationFailed();
    const token = authorization.slice('Bearer '.length);
    const record = this.#tokens.get(tokenDigest(token));
    if (!record || record.expiresAt <= this.#now().getTime()) throw authenticationFailed();
    return { tenantId: record.tenantId, subjectId: record.subjectId };
  }

  #discovery() {
    return {
      service: 'yanbot-harness-remote-reference-fixture',
      protocolVersion: HARNESS_PROTOCOL_VERSION,
      status: 'ok' as const,
      startedAt: this.#startedAt,
      profile: {
        executionMode: 'remote' as const,
        serviceVersion: HARNESS_RELEASE_VERSION,
        authentication: 'bearer' as const,
        capabilities: {
          workspaceSources: ['uploaded-snapshot'] as const,
          eventReplay: { durability: 'process' as const },
          interactions: { supported: true, maxWaitSeconds: 300 },
        },
      },
    };
  }

  async #createSession(principal: Principal, body: unknown): Promise<Session> {
    const input = createSessionRequestSchema.parse(body);
    if (input.adapterId !== adapterId) throw notFound('The adapter does not exist.');
    const timestamp = this.#now().toISOString();
    const session: Session = {
      protocolVersion: HARNESS_PROTOCOL_VERSION,
      sessionId: this.#generateId(),
      adapterId,
      ...(input.title === undefined ? {} : { title: input.title }),
      status: 'idle',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.#sessions.set(resourceKey(principal.tenantId, session.sessionId), {
      tenantId: principal.tenantId,
      session,
    });
    return session;
  }

  async #createRun(principal: Principal, sessionId: string, body: unknown, idempotencyKey?: string) {
    const input = createRunRequestSchema.parse(body);
    const sessionRecord = this.#session(principal, sessionId);
    const fingerprint = stableSerialize(input);
    const idempotencyRef =
      idempotencyKey === undefined ? undefined : resourceKey(principal.tenantId, sessionId, idempotencyKey);
    const previous = idempotencyRef === undefined ? undefined : this.#idempotency.get(idempotencyRef);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw conflict('The idempotency key was used with another request.');
      return { run: this.#run(principal, previous.runId).run, reused: true };
    }
    if (sessionRecord.session.status === 'running') throw conflict('The session already has an active run.');
    const snapshot = this.#snapshot(principal, input);
    if (input.model && input.model.adapterId !== adapterId) {
      throw invalid('The selected model belongs to another adapter.');
    }

    const timestamp = this.#now().toISOString();
    const run: Run = {
      protocolVersion: HARNESS_PROTOCOL_VERSION,
      runId: this.#generateId(),
      sessionId,
      adapterId,
      status: 'queued',
      prompt: input.prompt,
      ...(input.model === undefined ? {} : { model: input.model }),
      permissionPolicy: input.permissionPolicy,
      createdAt: timestamp,
    };
    const record: RunRecord = { tenantId: principal.tenantId, run, events: [], waiters: new Set() };
    this.#runs.set(resourceKey(principal.tenantId, run.runId), record);
    sessionRecord.session = {
      ...sessionRecord.session,
      status: 'running',
      lastRunId: run.runId,
      workspaceRef: snapshot.workspaceRef,
      updatedAt: timestamp,
    };
    if (idempotencyRef !== undefined) this.#idempotency.set(idempotencyRef, { fingerprint, runId: run.runId });

    try {
      record.controller = await createManagedAdapterRun(
        this.#adapter,
        { config: {} },
        {
          runId: run.runId,
          sessionId,
          ...(sessionRecord.session.adapterSessionId === undefined || !input.resume
            ? {}
            : { adapterSessionId: sessionRecord.session.adapterSessionId }),
          prompt: input.prompt,
          cwd: snapshot.cwd,
          ...(input.model === undefined ? {} : { model: input.model }),
          ...(input.maxTurns === undefined ? {} : { maxTurns: input.maxTurns }),
          permissionPolicy: input.permissionPolicy,
          configScopes: input.configScopes,
          extensions: input.extensions,
        },
      );
      void this.#consume(record, sessionRecord, record.controller);
    } catch (error) {
      this.#runs.delete(resourceKey(principal.tenantId, run.runId));
      if (idempotencyRef !== undefined) this.#idempotency.delete(idempotencyRef);
      sessionRecord.session = { ...sessionRecord.session, status: 'idle', updatedAt: this.#now().toISOString() };
      throw error;
    }
    return { run, reused: false };
  }

  #snapshot(principal: Principal, input: CreateRunRequest): SnapshotRecord {
    if (!('workspace' in input) || input.workspace.kind !== 'uploaded-snapshot') {
      throw unsupported('Remote Reference Fixture only supports uploaded-snapshot workspace sources.');
    }
    const snapshot = this.#snapshots.get(resourceKey(principal.tenantId, input.workspace.uploadId));
    if (!snapshot) throw notFound('The uploaded workspace does not exist.');
    if (!safeEqual(snapshot.digest, input.workspace.digest))
      throw invalid('The uploaded workspace digest does not match.');
    return snapshot;
  }

  async #consume(record: RunRecord, sessionRecord: SessionRecord, controller: ManagedRunController): Promise<void> {
    try {
      for await (const value of controller.events) {
        const event = adapterEventSchema.parse(value);
        record.events.push(event);
        record.run = updateRun(record.run, event);
        sessionRecord.session = updateSession(sessionRecord.session, record.run, event);
        if (event.type === 'interaction.requested') {
          this.#interactions.set(resourceKey(record.tenantId, event.payload.requestId), {
            tenantId: record.tenantId,
            runId: record.run.runId,
            controller,
          });
        } else if (event.type === 'interaction.resolved') {
          this.#interactions.delete(resourceKey(record.tenantId, event.payload.requestId));
        }
        notify(record);
      }
    } catch (error) {
      if (!record.events.some((event) => terminalTypes.has(event.type))) {
        const event = failureEvent(record.run, record.events.length + 1, this.#now(), this.#generateId(), error);
        record.events.push(event);
        record.run = updateRun(record.run, event);
        sessionRecord.session = updateSession(sessionRecord.session, record.run, event);
        notify(record);
      }
    } finally {
      await controller.dispose().catch(() => undefined);
      notify(record);
    }
  }

  #eventResponse(record: RunRecord, afterEventId?: string): Response {
    let startIndex = 0;
    if (afterEventId !== undefined) {
      const cursor = record.events.findIndex((event) => event.eventId === afterEventId);
      if (cursor < 0) throw invalid('The event cursor does not exist for this run.');
      startIndex = cursor + 1;
    }
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start: (streamController) => {
        void (async () => {
          const encoder = new TextEncoder();
          let index = startIndex;
          while (!cancelled && !this.#closed) {
            while (index < record.events.length) {
              const event = record.events[index++]!;
              streamController.enqueue(encoder.encode(`id: ${event.eventId}\ndata: ${JSON.stringify(event)}\n\n`));
              if (terminalTypes.has(event.type)) {
                streamController.close();
                return;
              }
            }
            await waitForEvent(record);
          }
          if (!cancelled) streamController.close();
        })().catch((error: unknown) => streamController.error(error));
      },
      cancel: () => {
        cancelled = true;
        notify(record);
      },
    });
    return new Response(stream, {
      headers: {
        'cache-control': 'no-store',
        'content-type': 'text/event-stream; charset=utf-8',
      },
    });
  }

  #session(principal: Principal, sessionId: string): SessionRecord {
    const record = this.#sessions.get(resourceKey(principal.tenantId, sessionId));
    if (!record) throw notFound('The session does not exist.');
    return record;
  }

  #run(principal: Principal, runId: string): RunRecord {
    const record = this.#runs.get(resourceKey(principal.tenantId, runId));
    if (!record) throw notFound('The run does not exist.');
    return record;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('The Remote Reference Fixture is closed.');
  }
}

class FixtureError extends Error {
  readonly status: number;
  readonly error: HarnessError;

  constructor(status: number, error: HarnessError) {
    super(error.message);
    this.name = 'FixtureError';
    this.status = status;
    this.error = error;
  }
}

function updateRun(run: Run, event: AdapterEvent): Run {
  const terminalEventType = isTerminalEvent(event) ? event.type : undefined;
  return {
    ...run,
    status: statusFromEvent(event, run.status),
    firstSequence: run.firstSequence ?? event.sequence,
    lastSequence: event.sequence,
    ...(event.type === 'run.started' && run.startedAt === undefined ? { startedAt: event.timestamp } : {}),
    ...(event.type === 'session.initialized' && event.payload.adapterSessionId
      ? { adapterSessionId: event.payload.adapterSessionId }
      : {}),
    ...(terminalEventType === undefined ? {} : { terminalEventType, completedAt: event.timestamp }),
  };
}

function updateSession(session: Session, run: Run, event: AdapterEvent): Session {
  const terminal = isTerminalEvent(event);
  return {
    ...session,
    ...(event.type === 'session.initialized' && event.payload.adapterSessionId
      ? { adapterSessionId: event.payload.adapterSessionId }
      : {}),
    status: terminal ? (event.type === 'run.failed' ? 'failed' : 'idle') : 'running',
    lastRunId: run.runId,
    updatedAt: event.timestamp,
  };
}

function isTerminalEvent(
  event: AdapterEvent,
): event is Extract<AdapterEvent, { type: 'run.completed' | 'run.failed' | 'run.cancelled' }> {
  return event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.cancelled';
}

function statusFromEvent(event: AdapterEvent, current: Run['status']): Run['status'] {
  if (event.type === 'run.started') return 'running';
  if (event.type === 'run.completed') return 'completed';
  if (event.type === 'run.failed') return 'failed';
  if (event.type === 'run.cancelled') return 'cancelled';
  return current;
}

function failureEvent(
  run: Run,
  sequence: number,
  now: Date,
  eventId: string,
  cause: unknown,
): Extract<AdapterEvent, { type: 'run.failed' }> {
  const error =
    cause instanceof HarnessAdapterError
      ? cause.toHarnessError()
      : { code: 'INTERNAL_ERROR' as const, message: 'The Reference Adapter run failed.', retryable: false };
  return {
    protocolVersion: HARNESS_PROTOCOL_VERSION,
    eventId,
    runId: run.runId,
    sessionId: run.sessionId,
    sequence,
    timestamp: now.toISOString(),
    type: 'run.failed',
    payload: { error },
  };
}

function waitForEvent(record: RunRecord): Promise<void> {
  return new Promise((resolve) => record.waiters.add(resolve));
}

function notify(record: RunRecord): void {
  for (const resolve of record.waiters) resolve();
  record.waiters.clear();
}

function parseCancelReason(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid('The request is invalid.');
  const keys = Object.keys(value);
  if (keys.some((key) => key !== 'reason')) throw invalid('The request is invalid.');
  const reason = (value as { reason?: unknown }).reason;
  if (reason === undefined) return undefined;
  if (typeof reason !== 'string' || reason.trim().length === 0 || reason.length > 1_024) {
    throw invalid('The cancellation reason is invalid.');
  }
  return reason.trim();
}

function errorResponse(error: unknown, requestId: string): Response {
  const fixtureError =
    error instanceof FixtureError
      ? error
      : error instanceof HarnessAdapterError
        ? new FixtureError(400, error.toHarnessError())
        : isValidationError(error)
          ? invalid('The request is invalid.')
          : new FixtureError(500, {
              code: 'INTERNAL_ERROR',
              message: 'The Remote Reference Fixture failed.',
              retryable: false,
            });
  const body: ApiError = apiErrorSchema.parse({ error: fixtureError.error, requestId });
  return Response.json(body, { status: fixtureError.status });
}

function isValidationError(error: unknown): boolean {
  return error instanceof Error && error.name === 'ZodError';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function authenticationFailed(): FixtureError {
  return new FixtureError(401, {
    code: 'AUTHENTICATION_FAILED',
    message: 'The Remote Runtime access token is invalid or expired.',
    retryable: false,
  });
}

function unsupported(message: string): FixtureError {
  return new FixtureError(400, { code: 'CAPABILITY_UNSUPPORTED', message, retryable: false });
}

function invalid(message: string): FixtureError {
  return new FixtureError(400, { code: 'CONFIGURATION_INVALID', message, retryable: false });
}

function notFound(message: string): FixtureError {
  return new FixtureError(404, { code: 'HARNESS_FAILED', message, retryable: false });
}

function conflict(message: string): FixtureError {
  return new FixtureError(409, { code: 'HARNESS_FAILED', message, retryable: false });
}

function tokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function resourceKey(...parts: string[]): string {
  return parts.map((part) => `${part.length}:${part}`).join('|');
}

function requiredIdentifier(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256) throw new TypeError(`${name} must be between 1 and 256 characters.`);
  return normalized;
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
