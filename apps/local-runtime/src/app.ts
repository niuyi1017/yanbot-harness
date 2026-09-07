import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { once } from 'node:events';

import { HarnessAdapterError } from '@yanbot-harness/adapter-api';
import { ConfigLoaderError } from '@yanbot-harness/config-loader';
import {
  HARNESS_PROTOCOL_VERSION,
  adapterIdSchema,
  configScopeSchema,
  createLocalRunRequestSchema,
  createLocalSessionRequestSchema,
  createWorkspaceGrantRequestSchema,
  interactionResponseSchema,
  uuidSchema,
  type HarnessError,
} from '@yanbot-harness/contracts';
import { ExtensionKitError } from '@yanbot-harness/extension-kit';
import express, { type ErrorRequestHandler, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';

import { LocalAuthError, type LocalAuthManager, type LocalAuthPrincipal } from './auth.js';
import { EventBufferOverflowError } from './event-hub.js';
import { StateStoreError } from './local-state-store.js';
import { RunSupervisorError, type RunSupervisor } from './run-supervisor.js';
import { WorkspaceGrantError, type WorkspaceGrantRegistry } from './workspace-grants.js';

const browserExchangeSchema = z.object({ token: z.string().min(1).max(1_024) }).strict();
const idempotencyKeySchema = z.string().trim().min(1).max(256);
const cancelRunSchema = z.object({ reason: z.string().trim().min(1).max(1_024).optional() }).strict();
const localInteractionResponseSchema = interactionResponseSchema.strict();

type AuthenticatedLocals = { requestId: string; principal: LocalAuthPrincipal };

export type CreateLocalRuntimeAppOptions = {
  auth: LocalAuthManager;
  workspaceGrants: WorkspaceGrantRegistry;
  supervisor: RunSupervisor;
  serviceName?: string;
  startedAt?: Date;
  sseHeartbeatMs?: number;
  generateRequestId?: () => string;
};

export function createLocalRuntimeApp(options: CreateLocalRuntimeAppOptions): express.Express {
  const app = express();
  const startedAt = (options.startedAt ?? new Date()).toISOString();
  const heartbeatMs = positiveInteger(options.sseHeartbeatMs, 15_000);
  const generateRequestId = options.generateRequestId ?? randomUUID;
  app.disable('x-powered-by');

  app.use((request, response, next) => {
    response.locals.requestId = uuidSchema.parse(generateRequestId());
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });
  app.use((request, _response, next) => {
    try {
      assertLoopbackHost(request.headers.host);
      next();
    } catch (error) {
      next(error);
    }
  });
  app.use(express.json({ limit: '1mb', strict: true }));

  app.get('/local/health', (_request, response) => {
    response.json({
      service: options.serviceName ?? 'yanbot-harness-local-runtime',
      protocolVersion: HARNESS_PROTOCOL_VERSION,
      status: 'ok',
      startedAt,
    });
  });

  app.post(
    '/local/auth/exchange',
    requireJson,
    asyncRoute(async (request, response) => {
      const origin = requiredHeader(request, 'origin');
      const input = browserExchangeSchema.parse(request.body);
      const session = options.auth.exchangeBrowserBinding(input.token, origin);
      response.setHeader('Set-Cookie', session.cookie);
      response.json({ expiresAt: session.expiresAt });
    }),
  );

  app.use('/local', (request, response, next) => {
    try {
      const authorization = optionalHeader(request, 'authorization');
      const cookie = optionalHeader(request, 'cookie');
      const origin = optionalHeader(request, 'origin');
      response.locals.principal = options.auth.authenticate({
        ...(authorization === undefined ? {} : { authorization }),
        ...(cookie === undefined ? {} : { cookie }),
        ...(origin === undefined ? {} : { origin }),
      });
      next();
    } catch (error) {
      next(error);
    }
  });

  app.post(
    '/local/workspaces/grants',
    requireJson,
    requireBearer,
    asyncRoute(async (request, response) => {
      const input = createWorkspaceGrantRequestSchema.parse(request.body);
      response.status(201).json(await options.workspaceGrants.issue(input.path, input.ttlMs));
    }),
  );

  app.delete(
    '/local/workspaces/grants/:grantId',
    requireBearer,
    asyncRoute(async (request, response) => {
      options.workspaceGrants.revoke(uuidSchema.parse(request.params.grantId));
      response.status(204).end();
    }),
  );

  app.get(
    '/local/sessions',
    asyncRoute(async (_request, response) => response.json(await options.supervisor.listSessions())),
  );
  app.post(
    '/local/sessions',
    requireJson,
    asyncRoute(async (request, response) => {
      response
        .status(201)
        .json(await options.supervisor.createSession(createLocalSessionRequestSchema.parse(request.body)));
    }),
  );
  app.get(
    '/local/sessions/:sessionId',
    asyncRoute(async (request, response) => {
      response.json(await options.supervisor.getSession(uuidSchema.parse(request.params.sessionId)));
    }),
  );
  app.post(
    '/local/sessions/:sessionId/runs',
    requireJson,
    asyncRoute(async (request, response) => {
      const result = await options.supervisor.createRun(
        uuidSchema.parse(request.params.sessionId),
        createLocalRunRequestSchema.parse(request.body),
        parseIdempotencyKey(request),
      );
      response.status(202).json(result);
    }),
  );
  app.get(
    '/local/runs/:runId',
    asyncRoute(async (request, response) => {
      response.json(await options.supervisor.getRun(uuidSchema.parse(request.params.runId)));
    }),
  );
  app.post(
    '/local/runs/:runId/cancel',
    requireJson,
    asyncRoute(async (request, response) => {
      const input = cancelRunSchema.parse(request.body);
      response.json(await options.supervisor.cancelRun(uuidSchema.parse(request.params.runId), input.reason));
    }),
  );
  app.post(
    '/local/interactions/:requestId/responses',
    requireJson,
    asyncRoute(async (request, response) => {
      const requestId = z.string().min(1).max(512).parse(request.params.requestId);
      const input = localInteractionResponseSchema.parse({ ...request.body, requestId });
      await options.supervisor.respondToInteraction(input);
      response.status(204).end();
    }),
  );

  app.get(
    '/local/runs/:runId/events',
    asyncRoute(async (request, response) => {
      const runId = uuidSchema.parse(request.params.runId);
      const queryCursor = optionalStringQuery(request.query.afterEventId);
      const headerCursor = optionalHeader(request, 'last-event-id');
      if (queryCursor && headerCursor && queryCursor !== headerCursor) {
        throw invalidRequest('The event cursor headers do not match.');
      }
      const cursor = queryCursor ?? headerCursor;
      if (cursor !== undefined) uuidSchema.parse(cursor);
      await options.supervisor.validateEventCursor(runId, cursor);

      response.status(200);
      response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      response.setHeader('Connection', 'keep-alive');
      response.setHeader('X-Accel-Buffering', 'no');
      response.flushHeaders();
      const abort = new AbortController();
      request.once('close', () => abort.abort());
      const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), heartbeatMs);
      heartbeat.unref();
      try {
        for await (const event of options.supervisor.events(runId, cursor, abort.signal)) {
          if (abort.signal.aborted) break;
          const payload = `id: ${event.eventId}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
          if (!response.write(payload)) await waitForDrain(response, abort.signal);
        }
      } finally {
        clearInterval(heartbeat);
        response.end();
      }
    }),
  );

  app.get(
    '/local/adapters',
    asyncRoute(async (_request, response) => response.json(await options.supervisor.listAdapters())),
  );
  app.get(
    '/local/models',
    asyncRoute(async (request, response) => {
      response.json(
        await options.supervisor.listModels(adapterIdSchema.parse(requiredStringQuery(request.query.adapterId))),
      );
    }),
  );
  app.get('/local/config/effective', (request, response) => {
    response.json(options.supervisor.effectiveConfig(parseScopes(request.query.scopes)).publicSummary);
  });
  app.get(
    '/local/extensions',
    asyncRoute(async (request, response) => {
      const adapterId = optionalStringQuery(request.query.adapterId);
      const extensions = await options.supervisor.listExtensions(
        adapterId === undefined ? undefined : adapterIdSchema.parse(adapterId),
      );
      response.json(
        extensions.map(({ descriptor, supported }) => ({
          descriptor,
          ...(supported === undefined ? {} : { supported }),
        })),
      );
    }),
  );

  app.use((_request, _response, next) => next(notFoundError('The local endpoint does not exist.')));
  app.use(errorHandler);
  return app;
}

function asyncRoute(
  handler: (request: Request, response: Response, next: NextFunction) => Promise<unknown>,
): (request: Request, response: Response, next: NextFunction) => void {
  return (request, response, next) => void handler(request, response, next).catch(next);
}

function requireJson(request: Request, _response: Response, next: NextFunction): void {
  if (!request.is('application/json')) {
    next(invalidRequest('The request must use application/json.'));
    return;
  }
  next();
}

function requireBearer(request: Request, response: Response<unknown, AuthenticatedLocals>, next: NextFunction): void {
  if (response.locals.principal?.kind !== 'bearer') {
    next(new LocalAuthError('FORBIDDEN', 'A privileged bearer token is required.'));
    return;
  }
  next();
}

const errorHandler: ErrorRequestHandler = (error, _request, response, next) => {
  if (response.headersSent) {
    next(error);
    return;
  }
  const mapped = mapError(error);
  const requestId = response.locals.requestId ?? randomUUID();
  response.status(mapped.status).json({ error: mapped.error, requestId });
};

function mapError(error: unknown): { status: number; error: HarnessError } {
  if (error instanceof RunSupervisorError) return { status: error.status, error: error.error };
  if (error instanceof LocalAuthError) {
    return {
      status: error.code === 'UNAUTHORIZED' ? 401 : 403,
      error: {
        code: error.code === 'UNAUTHORIZED' ? 'AUTHENTICATION_FAILED' : 'PERMISSION_DENIED',
        message: error.message,
        retryable: false,
      },
    };
  }
  if (error instanceof WorkspaceGrantError) {
    return { status: 403, error: { code: 'PERMISSION_DENIED', message: error.message, retryable: false } };
  }
  if (error instanceof StateStoreError) {
    const status = error.code === 'STATE_NOT_FOUND' ? 404 : error.code === 'STATE_CONFLICT' ? 409 : 500;
    return { status, error: { code: 'HARNESS_FAILED', message: error.message, retryable: status >= 500 } };
  }
  if (error instanceof HarnessAdapterError) return { status: adapterStatus(error), error: error.toHarnessError() };
  if (error instanceof ConfigLoaderError || error instanceof ExtensionKitError) {
    return {
      status: error.code.endsWith('OUTSIDE_ROOT') ? 403 : error.code === 'CAPABILITY_UNSUPPORTED' ? 400 : 400,
      error: {
        code: error.code === 'CAPABILITY_UNSUPPORTED' ? 'CAPABILITY_UNSUPPORTED' : 'CONFIGURATION_INVALID',
        message: error.message,
        retryable: false,
      },
    };
  }
  if (error instanceof EventBufferOverflowError) {
    return { status: 409, error: { code: 'HARNESS_FAILED', message: error.message, retryable: true } };
  }
  if (error instanceof z.ZodError || isBodyParserError(error)) {
    const tooLarge = isBodyParserError(error) && error.type === 'entity.too.large';
    return {
      status: tooLarge ? 413 : 400,
      error: { code: 'CONFIGURATION_INVALID', message: 'The request is invalid.', retryable: false },
    };
  }
  return { status: 500, error: { code: 'INTERNAL_ERROR', message: 'The local runtime failed.', retryable: false } };
}

function adapterStatus(error: HarnessAdapterError): number {
  if (error.code === 'ADAPTER_UNAVAILABLE' || error.code === 'AUTHENTICATION_FAILED') return 503;
  if (error.code === 'INTERACTION_EXPIRED') return 409;
  if (error.code === 'PERMISSION_DENIED') return 403;
  if (error.code === 'CONFIGURATION_INVALID' || error.code === 'CAPABILITY_UNSUPPORTED') return 400;
  return 500;
}

function assertLoopbackHost(host: string | undefined): void {
  if (!host) throw new LocalAuthError('FORBIDDEN', 'A loopback Host header is required.');
  let hostname: string;
  try {
    hostname = new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, '');
  } catch {
    throw new LocalAuthError('FORBIDDEN', 'The Host header is invalid.');
  }
  const ipVersion = isIP(hostname);
  if (hostname !== 'localhost' && hostname !== '::1' && !(ipVersion === 4 && hostname.startsWith('127.'))) {
    throw new LocalAuthError('FORBIDDEN', 'The Host header is not loopback.');
  }
}

function parseIdempotencyKey(request: Request): string | undefined {
  const value = optionalHeader(request, 'idempotency-key');
  return value === undefined ? undefined : idempotencyKeySchema.parse(value);
}

function parseScopes(value: unknown) {
  const text = optionalStringQuery(value);
  return z.array(configScopeSchema).parse(text === undefined || text === '' ? [] : text.split(','));
}

function requiredHeader(request: Request, name: string): string {
  const value = optionalHeader(request, name);
  if (value === undefined) throw invalidRequest(`The ${name} header is required.`);
  return value;
}

function optionalHeader(request: Request, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function requiredStringQuery(value: unknown): string {
  const parsed = optionalStringQuery(value);
  if (parsed === undefined) throw invalidRequest('A required query value is missing.');
  return parsed;
}

function optionalStringQuery(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw invalidRequest('The query value must be a string.');
  return value;
}

function invalidRequest(message: string): RunSupervisorError {
  return new RunSupervisorError(400, { code: 'CONFIGURATION_INVALID', message, retryable: false });
}

function notFoundError(message: string): RunSupervisorError {
  return new RunSupervisorError(404, { code: 'HARNESS_FAILED', message, retryable: false });
}

function isBodyParserError(error: unknown): error is { type: string } {
  return typeof error === 'object' && error !== null && 'type' in error && typeof error.type === 'string';
}

async function waitForDrain(response: Response, signal: AbortSignal): Promise<void> {
  const aborted = new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });
  await Promise.race([once(response, 'drain'), aborted]);
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isInteger(value) || value <= 0 ? fallback : value;
}
