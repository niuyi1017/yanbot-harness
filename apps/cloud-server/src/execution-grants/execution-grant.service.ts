import { randomBytes, randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import {
  adapterEventSchema,
  interactionResponseSchema,
  runSchema,
  sessionSchema,
  type AdapterEvent,
} from '@yanbot-harness/contracts';

import { AuthService } from '../auth/auth.service.js';
import { conflict, permissionDenied, resourceNotFound } from '../common/cloud-error.js';
import type { CloudConfig } from '../config.js';
import type { ExecutionGrantAction, ExecutionGrantRecord, RunRecord } from '../domain.js';
import { CONTROL_PLANE_STORE, type ControlPlaneStore } from '../persistence/control-plane.store.js';
import { CLOUD_CONFIG } from '../persistence/mongo.service.js';
import { ControlPlaneService } from '../control-plane/control-plane.service.js';
import { AuditService } from '../audit/audit.service.js';

const allActions: ExecutionGrantAction[] = ['workspace.read', 'events.append', 'interaction.read', 'run.complete'];
const terminalTypes = new Set<AdapterEvent['type']>(['run.completed', 'run.failed', 'run.cancelled']);

@Injectable()
export class ExecutionGrantService {
  readonly #store: ControlPlaneStore;
  readonly #auth: AuthService;
  readonly #controlPlane: ControlPlaneService;
  readonly #config: CloudConfig;
  readonly #audit: AuditService;

  constructor(
    @Inject(CONTROL_PLANE_STORE) store: ControlPlaneStore,
    @Inject(AuthService) auth: AuthService,
    @Inject(ControlPlaneService) controlPlane: ControlPlaneService,
    @Inject(CLOUD_CONFIG) config: CloudConfig,
    @Inject(AuditService) audit: AuditService,
  ) {
    this.#store = store;
    this.#auth = auth;
    this.#controlPlane = controlPlane;
    this.#config = config;
    this.#audit = audit;
  }

  async issue(
    run: RunRecord,
    attempt = 1,
    auditRequestId: string = randomUUID(),
  ): Promise<{ executionGrant: string; expiresAt: string }> {
    const executionGrant = `yhe_${randomBytes(32).toString('base64url')}`;
    const expiresAt = new Date(Date.now() + Math.min(this.#config.workspaceTtlSeconds, 3_600) * 1_000);
    await this.#store.insertExecutionGrant({
      organizationId: run.organizationId,
      runId: run.runId,
      workspaceRef: run.workspaceRef,
      attempt,
      digest: this.#auth.digest(executionGrant),
      actions: allActions,
      expiresAt,
    });
    await this.#audit.record({
      requestId: auditRequestId,
      organizationId: run.organizationId,
      subjectId: run.userId,
      action: 'execution-grant.issue',
      resourceType: 'run',
      resourceId: run.runId,
      outcome: 'succeeded',
      status: 201,
    });
    return { executionGrant, expiresAt: expiresAt.toISOString() };
  }

  async claim(rawGrant: string, auditRequestId: string = randomUUID()): Promise<Omit<ExecutionGrantRecord, 'digest'>> {
    this.#enabled();
    const claimed = await this.#store.claimExecutionGrant(this.#auth.digest(rawGrant), new Date());
    if (!claimed) {
      await this.#audit.record({
        requestId: auditRequestId,
        action: 'execution-grant.claim',
        outcome: 'rejected',
        status: 403,
      });
      throw permissionDenied();
    }
    await this.#audit.record({
      requestId: auditRequestId,
      organizationId: claimed.organizationId,
      action: 'execution-grant.claim',
      resourceType: 'run',
      resourceId: claimed.runId,
      outcome: 'succeeded',
      status: 200,
    });
    return {
      organizationId: claimed.organizationId,
      runId: claimed.runId,
      workspaceRef: claimed.workspaceRef,
      attempt: claimed.attempt,
      actions: claimed.actions,
      expiresAt: claimed.expiresAt,
      ...(claimed.claimedAt === undefined ? {} : { claimedAt: claimed.claimedAt }),
      ...(claimed.revokedAt === undefined ? {} : { revokedAt: claimed.revokedAt }),
    };
  }

  async workspace(rawGrant: string, runId: string, attempt: number) {
    const grant = await this.#authorize(rawGrant, runId, attempt, 'workspace.read');
    const workspace = await this.#store.findWorkspace(grant.organizationId, grant.workspaceRef);
    if (!workspace || workspace.status !== 'ready' || workspace.expiresAt <= new Date()) throw resourceNotFound();
    return { workspaceRef: workspace.workspaceRef, source: workspace.source, storageKey: workspace.storageKey };
  }

  async interaction(rawGrant: string, runId: string, attempt: number, requestId: string) {
    const grant = await this.#authorize(rawGrant, runId, attempt, 'interaction.read');
    const interaction = await this.#store.findInteraction(grant.organizationId, requestId);
    if (!interaction || interaction.runId !== runId) throw resourceNotFound();
    return interactionResponseSchema.parse(interaction.response);
  }

  async append(rawGrant: string, runId: string, attempt: number, value: unknown): Promise<AdapterEvent> {
    const event = adapterEventSchema.parse(value);
    const requiredAction: ExecutionGrantAction = terminalTypes.has(event.type) ? 'run.complete' : 'events.append';
    const grant = await this.#authorize(rawGrant, runId, attempt, requiredAction);
    if (event.runId !== runId) throw permissionDenied();
    return this.#store.transaction(async () => {
      const run = await this.#store.findRun(grant.organizationId, runId);
      if (!run || run.sessionId !== event.sessionId) throw permissionDenied();
      if (run.value.terminalEventType) throw conflict('The run is already terminal.');
      const expectedSequence = (run.value.lastSequence ?? 0) + 1;
      if (event.sequence !== expectedSequence) throw conflict('The event sequence is not contiguous.');
      const session = await this.#store.findSession(grant.organizationId, run.sessionId);
      if (!session) throw resourceNotFound();
      const terminal = terminalTypes.has(event.type);
      const status =
        event.type === 'run.started'
          ? 'running'
          : event.type === 'run.completed'
            ? 'completed'
            : event.type === 'run.cancelled'
              ? 'cancelled'
              : event.type === 'run.failed'
                ? 'failed'
                : run.value.status;
      const nextRun = runSchema.parse({
        ...run.value,
        status,
        firstSequence: run.value.firstSequence ?? event.sequence,
        lastSequence: event.sequence,
        ...(event.type === 'run.started' ? { startedAt: event.timestamp } : {}),
        ...(terminal ? { terminalEventType: event.type, completedAt: event.timestamp } : {}),
      });
      const nextSession = sessionSchema.parse({
        ...session.value,
        status: terminal ? (event.type === 'run.failed' ? 'failed' : 'idle') : 'running',
        updatedAt: event.timestamp,
      });
      await this.#store.insertEvent(this.#controlPlane.eventRecord(grant.organizationId, event));
      await this.#store.replaceRunAndSession({ ...run, value: nextRun }, { ...session, value: nextSession });
      if (terminal) await this.#store.revokeRunGrants(grant.organizationId, runId, new Date());
      return event;
    });
  }

  async #authorize(rawGrant: string, runId: string, attempt: number, action: ExecutionGrantAction) {
    this.#enabled();
    const record = await this.#store.findExecutionGrant(this.#auth.digest(rawGrant));
    if (
      !record ||
      !record.claimedAt ||
      record.revokedAt ||
      record.expiresAt <= new Date() ||
      record.runId !== runId ||
      record.attempt !== attempt ||
      !record.actions.includes(action)
    ) {
      throw permissionDenied();
    }
    return record;
  }

  #enabled(): void {
    if (!this.#config.internalApiEnabled) throw resourceNotFound();
  }
}
