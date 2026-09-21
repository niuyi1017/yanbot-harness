import { createHash, randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import {
  HARNESS_PROTOCOL_VERSION,
  adapterEventSchema,
  adapterSummarySchema,
  createRunRequestSchema,
  createRunResultSchema,
  createSessionRequestSchema,
  interactionResponseSchema,
  modelDescriptorSchema,
  runSchema,
  sessionSchema,
  uuidSchema,
  type AdapterEvent,
  type CreateRunResult,
  type Run,
  type Session,
} from '@yanbot-harness/contracts';

import { conflict, invalidConfiguration, resourceNotFound } from '../common/cloud-error.js';
import type { CloudConfig } from '../config.js';
import type { EventRecord, RunRecord, TenantPrincipal } from '../domain.js';
import { CONTROL_PLANE_STORE, type ControlPlaneStore } from '../persistence/control-plane.store.js';
import { CLOUD_CONFIG } from '../persistence/mongo.service.js';
import { WorkspaceService } from '../workspaces/workspace.service.js';

const adapterId = 'cn.yanbot.reference';
const terminalStatuses = new Set<Run['status']>(['completed', 'failed', 'cancelled', 'interrupted']);

export const referenceAdapterSummary = adapterSummarySchema.parse({
  manifest: {
    protocolVersion: HARNESS_PROTOCOL_VERSION,
    adapterId,
    adapterVersion: '0.1.0',
    displayName: 'Yanbot Reference Adapter',
    harness: { name: 'Deterministic Reference Harness', version: '0.1.0' },
    runtimeKinds: ['in-process'],
  },
  capabilities: {
    'sessions.resume': { level: 'emulated' },
    'runs.cancel': { level: 'native' },
    'streaming.text': { level: 'native' },
    'streaming.tool-events': { level: 'native' },
    'interactions.permissions': { level: 'native' },
    'interactions.questions': { level: 'native' },
    'models.list': { level: 'native' },
  },
});

export const referenceModel = modelDescriptorSchema.parse({
  ref: { adapterId, modelId: 'deterministic' },
  name: 'Deterministic Reference Model',
  description: 'Offline model used for protocol and client tests.',
});

@Injectable()
export class ControlPlaneService {
  readonly #store: ControlPlaneStore;
  readonly #workspaces: WorkspaceService;
  readonly #config: CloudConfig;
  readonly #now: () => Date;
  readonly #generateId: () => string;

  constructor(
    @Inject(CONTROL_PLANE_STORE) store: ControlPlaneStore,
    @Inject(WorkspaceService) workspaces: WorkspaceService,
    @Inject(CLOUD_CONFIG) config: CloudConfig,
  ) {
    this.#store = store;
    this.#workspaces = workspaces;
    this.#config = config;
    this.#now = () => new Date();
    this.#generateId = randomUUID;
  }

  listAdapters() {
    return [referenceAdapterSummary];
  }

  listModels(selectedAdapterId: string) {
    if (selectedAdapterId !== adapterId) throw resourceNotFound();
    return [referenceModel];
  }

  async createSession(principal: TenantPrincipal, value: unknown): Promise<Session> {
    const input = createSessionRequestSchema.parse(value);
    if (input.adapterId !== adapterId) throw resourceNotFound();
    const timestamp = this.#now().toISOString();
    const session = sessionSchema.parse({
      protocolVersion: HARNESS_PROTOCOL_VERSION,
      sessionId: this.#generateId(),
      adapterId,
      ...(input.title === undefined ? {} : { title: input.title }),
      status: 'idle',
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await this.#store.insertSession({
      organizationId: principal.organizationId,
      userId: principal.userId,
      value: session,
    });
    return session;
  }

  async listSessions(principal: TenantPrincipal): Promise<Session[]> {
    return (await this.#store.listSessions(principal.organizationId)).map((record) =>
      sessionSchema.parse(record.value),
    );
  }

  async getSession(principal: TenantPrincipal, sessionIdValue: unknown): Promise<Session> {
    const sessionId = uuidSchema.parse(sessionIdValue);
    const record = await this.#store.findSession(principal.organizationId, sessionId);
    if (!record) throw resourceNotFound();
    return sessionSchema.parse(record.value);
  }

  async createRun(
    principal: TenantPrincipal,
    sessionIdValue: unknown,
    value: unknown,
    idempotencyKey?: string,
  ): Promise<CreateRunResult> {
    const sessionId = uuidSchema.parse(sessionIdValue);
    const input = createRunRequestSchema.parse(value);
    if (!('workspace' in input) || input.workspace.kind === 'local-path-grant') {
      throw invalidConfiguration('Remote runs require a prepared workspace source.');
    }
    if (input.model && input.model.adapterId !== adapterId)
      throw invalidConfiguration('The selected model is invalid.');
    const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    return this.#store.transaction(async () => {
      if (idempotencyKey) {
        const previous = await this.#store.findIdempotentRun(principal.organizationId, sessionId, idempotencyKey);
        if (previous) {
          if (previous.inputFingerprint !== fingerprint)
            throw conflict('The idempotency key was used with another request.');
          return createRunResultSchema.parse({ run: previous.value, reused: true });
        }
      }
      const sessionRecord = await this.#store.findSession(principal.organizationId, sessionId);
      if (!sessionRecord) throw resourceNotFound();
      if (sessionRecord.value.status === 'running') throw conflict('The session already has an active run.');
      const workspace = await this.#workspaces.requireReady(principal.organizationId, input.workspace);
      const timestamp = this.#now().toISOString();
      const run = runSchema.parse({
        protocolVersion: HARNESS_PROTOCOL_VERSION,
        runId: this.#generateId(),
        sessionId,
        adapterId,
        status: 'queued',
        prompt: input.prompt,
        ...(input.model === undefined ? {} : { model: input.model }),
        permissionPolicy: input.permissionPolicy,
        createdAt: timestamp,
      });
      const runRecord: RunRecord = {
        organizationId: principal.organizationId,
        userId: principal.userId,
        sessionId,
        runId: run.runId,
        workspaceRef: workspace.workspaceRef,
        value: run,
        inputFingerprint: fingerprint,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      };
      const nextSession = sessionSchema.parse({
        ...sessionRecord.value,
        status: 'running',
        updatedAt: timestamp,
        lastRunId: run.runId,
        workspaceRef: workspace.workspaceRef,
      });
      await this.#store.insertRunAndOutbox(
        runRecord,
        {
          organizationId: principal.organizationId,
          outboxId: this.#generateId(),
          runId: run.runId,
          attempt: 1,
          kind: 'run.requested',
          status: 'pending',
          availableAt: this.#now(),
          createdAt: this.#now(),
        },
        { ...sessionRecord, value: nextSession },
      );
      return createRunResultSchema.parse({ run, reused: false });
    });
  }

  async getRun(principal: TenantPrincipal, runIdValue: unknown): Promise<Run> {
    const runId = uuidSchema.parse(runIdValue);
    const record = await this.#store.findRun(principal.organizationId, runId);
    if (!record) throw resourceNotFound();
    return runSchema.parse(record.value);
  }

  async cancelRun(principal: TenantPrincipal, runIdValue: unknown, reason?: string): Promise<Run> {
    const runId = uuidSchema.parse(runIdValue);
    return this.#store.transaction(async () => {
      const record = await this.#store.findRun(principal.organizationId, runId);
      if (!record) throw resourceNotFound();
      if (terminalStatuses.has(record.value.status)) return record.value;
      const session = await this.#store.findSession(principal.organizationId, record.sessionId);
      if (!session) throw resourceNotFound();
      const timestamp = this.#now().toISOString();
      const sequence = (record.value.lastSequence ?? 0) + 1;
      const event = adapterEventSchema.parse({
        protocolVersion: HARNESS_PROTOCOL_VERSION,
        eventId: this.#generateId(),
        runId,
        sessionId: record.sessionId,
        sequence,
        timestamp,
        type: 'run.cancelled',
        payload: { ...(reason === undefined ? {} : { reason }) },
      });
      const nextRun = runSchema.parse({
        ...record.value,
        status: 'cancelled',
        firstSequence: record.value.firstSequence ?? sequence,
        lastSequence: sequence,
        terminalEventType: 'run.cancelled',
        completedAt: timestamp,
      });
      const nextSession = sessionSchema.parse({ ...session.value, status: 'idle', updatedAt: timestamp });
      await this.#store.insertEvent(this.#eventRecord(principal.organizationId, event));
      await this.#store.replaceRunAndSession({ ...record, value: nextRun }, { ...session, value: nextSession });
      await this.#store.cancelOutbox(principal.organizationId, runId);
      await this.#store.revokeRunGrants(principal.organizationId, runId, this.#now());
      return nextRun;
    });
  }

  async listEvents(principal: TenantPrincipal, runIdValue: unknown, afterEventId?: string): Promise<AdapterEvent[]> {
    const runId = uuidSchema.parse(runIdValue);
    if (!(await this.#store.findRun(principal.organizationId, runId))) throw resourceNotFound();
    let sequence = 0;
    if (afterEventId) {
      const cursor = await this.#store.findEvent(principal.organizationId, runId, uuidSchema.parse(afterEventId));
      if (!cursor) throw resourceNotFound();
      sequence = cursor.sequence;
    }
    return (await this.#store.listEvents(principal.organizationId, runId, sequence)).map((record) =>
      adapterEventSchema.parse(record.value),
    );
  }

  async respond(principal: TenantPrincipal, requestId: string, value: unknown): Promise<void> {
    const response = interactionResponseSchema.parse(
      typeof value === 'object' && value !== null ? { ...value, requestId } : { requestId },
    );
    const requested = await this.#store.findInteractionRequest(principal.organizationId, response.requestId);
    if (!requested) throw resourceNotFound();
    const status = await this.#store.insertInteraction({
      organizationId: principal.organizationId,
      runId: requested.runId,
      requestId: response.requestId,
      response,
      expiresAt: new Date(this.#now().getTime() + this.#config.eventRetentionSeconds * 1_000),
    });
    if (status === 'existing') {
      const existing = await this.#store.findInteraction(principal.organizationId, response.requestId);
      if (!existing || JSON.stringify(existing.response) !== JSON.stringify(response)) throw conflict();
    }
  }

  eventRecord(organizationId: string, value: AdapterEvent): EventRecord {
    return this.#eventRecord(organizationId, value);
  }

  #eventRecord(organizationId: string, value: AdapterEvent): EventRecord {
    return {
      organizationId,
      runId: value.runId,
      eventId: value.eventId,
      sequence: value.sequence,
      value,
      expiresAt: new Date(this.#now().getTime() + this.#config.eventRetentionSeconds * 1_000),
    };
  }
}
