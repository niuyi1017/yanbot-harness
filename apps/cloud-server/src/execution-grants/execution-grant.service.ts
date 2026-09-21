import { randomBytes, randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import {
  adapterEventSchema,
  interactionResponseSchema,
  runSchema,
  sessionSchema,
  type AdapterEvent,
} from '@yanbot-harness/contracts';
import { z } from 'zod';

import { AuthService } from '../auth/auth.service.js';
import { conflict, permissionDenied, resourceNotFound } from '../common/cloud-error.js';
import type { CloudConfig } from '../config.js';
import type { ExecutionGrantAction, ExecutionGrantRecord, RunRecord } from '../domain.js';
import { CONTROL_PLANE_STORE, type ControlPlaneStore } from '../persistence/control-plane.store.js';
import { CLOUD_CONFIG } from '../persistence/mongo.service.js';
import { ControlPlaneService } from '../control-plane/control-plane.service.js';
import { AuditService } from '../audit/audit.service.js';

const allActions: ExecutionGrantAction[] = [
  'run.read',
  'workspace.read',
  'events.append',
  'interaction.read',
  'run.complete',
];
const workerIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{1,128}$/u);
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

  async claim(
    rawGrant: string,
    workerIdValue: unknown,
    auditRequestId: string = randomUUID(),
  ): Promise<Omit<ExecutionGrantRecord, 'digest'>> {
    this.#enabled();
    const workerId = workerIdSchema.parse(workerIdValue);
    const now = new Date();
    const claimed = await this.#store.claimExecutionGrantAndAttempt(
      this.#auth.digest(rawGrant),
      workerId,
      now,
      new Date(now.getTime() + this.#config.runLeaseMs),
    );
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
      ...(claimed.claimedBy === undefined ? {} : { claimedBy: claimed.claimedBy }),
      ...(claimed.claimedAt === undefined ? {} : { claimedAt: claimed.claimedAt }),
      ...(claimed.revokedAt === undefined ? {} : { revokedAt: claimed.revokedAt }),
    };
  }

  async workspace(rawGrant: string, runId: string, attempt: number, workerIdValue: unknown) {
    const grant = await this.#authorize(rawGrant, runId, attempt, 'workspace.read', workerIdValue);
    const workspace = await this.#store.findWorkspace(grant.organizationId, grant.workspaceRef);
    if (!workspace || workspace.status !== 'ready' || workspace.expiresAt <= new Date()) throw resourceNotFound();
    return { workspaceRef: workspace.workspaceRef, source: workspace.source, storageKey: workspace.storageKey };
  }

  async run(rawGrant: string, runId: string, attempt: number, workerIdValue: unknown) {
    const grant = await this.#authorize(rawGrant, runId, attempt, 'run.read', workerIdValue);
    const record = await this.#store.findRun(grant.organizationId, runId);
    if (!record) throw resourceNotFound();
    return runSchema.parse(record.value);
  }

  async heartbeat(
    rawGrant: string,
    runId: string,
    attempt: number,
    workerIdValue: unknown,
    auditRequestId: string = randomUUID(),
  ): Promise<void> {
    const workerId = workerIdSchema.parse(workerIdValue);
    const grant = await this.#authorize(rawGrant, runId, attempt, 'run.read', workerId);
    const record = await this.#store.findRun(grant.organizationId, runId);
    if (!record || record.value.terminalEventType) throw permissionDenied();
    const now = new Date();
    if (
      !(await this.#store.heartbeatRunAttempt(
        grant.organizationId,
        runId,
        attempt,
        workerId,
        now,
        new Date(now.getTime() + this.#config.runLeaseMs),
      ))
    ) {
      throw permissionDenied();
    }
    await this.#audit.record({
      requestId: auditRequestId,
      organizationId: grant.organizationId,
      action: 'run.heartbeat',
      resourceType: 'run',
      resourceId: runId,
      outcome: 'succeeded',
      status: 204,
    });
  }

  async interaction(rawGrant: string, runId: string, attempt: number, requestId: string, workerIdValue: unknown) {
    const grant = await this.#authorize(rawGrant, runId, attempt, 'interaction.read', workerIdValue);
    const interaction = await this.#store.findInteraction(grant.organizationId, requestId);
    if (!interaction || interaction.runId !== runId) throw resourceNotFound();
    return interactionResponseSchema.parse(interaction.response);
  }

  async append(
    rawGrant: string,
    runId: string,
    attempt: number,
    value: unknown,
    workerIdValue: unknown,
    auditRequestId: string = randomUUID(),
  ): Promise<AdapterEvent> {
    const event = adapterEventSchema.parse(value);
    const requiredAction: ExecutionGrantAction = terminalTypes.has(event.type) ? 'run.complete' : 'events.append';
    const grant = await this.#authorize(rawGrant, runId, attempt, requiredAction, workerIdValue);
    if (event.runId !== runId) throw permissionDenied();
    const saved = await this.#store.transaction(async () => {
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
      if (terminal) {
        await this.#store.closeRunAttempt(
          grant.organizationId,
          runId,
          attempt,
          event.type === 'run.failed' ? 'failed' : 'completed',
          new Date(),
          event.type === 'run.failed' ? event.payload.error.code : undefined,
          grant.claimedBy,
        );
        await this.#store.revokeRunGrants(grant.organizationId, runId, new Date());
        if (await this.#store.releaseRunAdmission(grant.organizationId, runId, new Date())) {
          await this.#audit.record({
            requestId: auditRequestId,
            organizationId: grant.organizationId,
            action: 'run.admission.release',
            resourceType: 'run',
            resourceId: runId,
            outcome: 'succeeded',
            status: 200,
          });
        }
      }
      return event;
    });
    if (terminalTypes.has(event.type)) {
      await this.#audit.record({
        requestId: auditRequestId,
        organizationId: grant.organizationId,
        action: 'run.terminal',
        resourceType: 'run',
        resourceId: runId,
        outcome: 'succeeded',
        status: 201,
      });
    }
    return saved;
  }

  async #authorize(
    rawGrant: string,
    runId: string,
    attempt: number,
    action: ExecutionGrantAction,
    workerIdValue: unknown,
  ) {
    this.#enabled();
    const workerId = workerIdSchema.parse(workerIdValue);
    const record = await this.#store.findExecutionGrant(this.#auth.digest(rawGrant));
    if (
      !record ||
      !record.claimedAt ||
      record.revokedAt ||
      record.expiresAt <= new Date() ||
      record.runId !== runId ||
      record.attempt !== attempt ||
      record.claimedBy !== workerId ||
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
