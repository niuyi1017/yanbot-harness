import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import {
  REMOTE_RUN_JOB_NAME,
  createQueueConnection,
  createRemoteRunQueue,
  remoteRunJobId,
  type RemoteQueueConnection,
  type RemoteRunJob,
} from '@yanbot-harness/cloud-queue';

import { AuditService } from '../audit/audit.service.js';
import type { CloudConfig } from '../config.js';
import { ControlPlaneService } from '../control-plane/control-plane.service.js';
import type { OutboxRecord, RunAttemptRecord } from '../domain.js';
import { ExecutionGrantService } from '../execution-grants/execution-grant.service.js';
import { CONTROL_PLANE_STORE, type ControlPlaneStore } from '../persistence/control-plane.store.js';
import { CLOUD_CONFIG } from '../persistence/mongo.service.js';

export const DISPATCH_QUEUE = Symbol('DISPATCH_QUEUE');

export type DispatchQueue = {
  add(name: string, data: RemoteRunJob, options: { jobId: string }): Promise<unknown>;
  getJob(jobId: string): Promise<{ remove(): Promise<void> } | undefined>;
  close(): Promise<void>;
};

const terminalStatuses = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

@Injectable()
export class DispatchService implements OnApplicationBootstrap, OnApplicationShutdown {
  readonly #logger = new Logger(DispatchService.name);
  readonly #owner = `relay-${randomUUID()}`;
  readonly #store: ControlPlaneStore;
  readonly #grants: ExecutionGrantService;
  readonly #controlPlane: ControlPlaneService;
  readonly #audit: AuditService;
  readonly #config: CloudConfig;
  #queue: DispatchQueue | undefined;
  #connection: RemoteQueueConnection | undefined;
  #timer: NodeJS.Timeout | undefined;
  #running = false;

  constructor(
    @Inject(CONTROL_PLANE_STORE) store: ControlPlaneStore,
    @Inject(ExecutionGrantService) grants: ExecutionGrantService,
    @Inject(ControlPlaneService) controlPlane: ControlPlaneService,
    @Inject(AuditService) audit: AuditService,
    @Inject(CLOUD_CONFIG) config: CloudConfig,
    @Optional() @Inject(DISPATCH_QUEUE) queue?: DispatchQueue,
  ) {
    this.#store = store;
    this.#grants = grants;
    this.#controlPlane = controlPlane;
    this.#audit = audit;
    this.#config = config;
    this.#queue = queue;
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.#config.relayEnabled) return;
    if (!this.#queue) {
      if (!this.#config.redisUrl) throw new Error('The Remote relay requires Redis.');
      this.#connection = createQueueConnection(this.#config.redisUrl);
      await this.#connection.connect();
      this.#queue = createRemoteRunQueue(this.#config.queueName, this.#connection);
    }
    await this.tick();
    this.#timer = setInterval(() => void this.tick(), this.#config.relayIntervalMs);
    this.#timer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    await this.#queue?.close();
    if (this.#connection) await this.#connection.quit();
  }

  async tick(): Promise<void> {
    if (this.#running || !this.#queue) return;
    this.#running = true;
    try {
      for (let count = 0; count < 100 && (await this.dispatchOnce()); count += 1) continue;
      await this.reapOnce();
    } catch {
      this.#logger.error('Remote dispatch tick failed.');
    } finally {
      this.#running = false;
    }
  }

  async dispatchOnce(): Promise<boolean> {
    if (!this.#queue) return false;
    const now = new Date();
    const outbox = await this.#store.claimDispatchOutbox(
      this.#owner,
      now,
      new Date(now.getTime() + this.#config.relayLeaseMs),
    );
    if (!outbox) return false;
    const run = await this.#store.findRun(outbox.organizationId, outbox.runId);
    if (!run || terminalStatuses.has(run.value.status)) {
      await this.#store.cancelOutboxRecord(outbox.organizationId, outbox.outboxId, this.#owner);
      return true;
    }

    const queueJobId = remoteRunJobId(outbox.runId, outbox.attempt);
    const existing = await this.#store.findRunAttempt(outbox.organizationId, outbox.runId, outbox.attempt);
    if (existing) {
      const job = await this.#queue.getJob(queueJobId);
      if (job) {
        if (existing.status === 'dispatching') {
          await this.#store.replaceRunAttempt({ ...existing, status: 'queued', updatedAt: now });
        }
        await this.#store.markOutboxPublished(outbox.organizationId, outbox.outboxId, this.#owner, queueJobId, now);
        return true;
      }
      await this.#retry(outbox, existing, 'QUEUE_JOB_MISSING');
      return true;
    }

    try {
      const issued = await this.#grants.issue(run, outbox.attempt, outbox.outboxId);
      const attempt: RunAttemptRecord = {
        organizationId: outbox.organizationId,
        runId: outbox.runId,
        attempt: outbox.attempt,
        queueJobId,
        status: 'dispatching',
        active: true,
        createdAt: now,
        updatedAt: now,
      };
      await this.#store.insertRunAttempt(attempt);
      const latest = await this.#store.findRun(outbox.organizationId, outbox.runId);
      if (!latest || terminalStatuses.has(latest.value.status)) {
        await this.#store.closeRunAttempt(
          outbox.organizationId,
          outbox.runId,
          outbox.attempt,
          'abandoned',
          new Date(),
          'RUN_TERMINAL',
        );
        await this.#store.revokeRunGrants(outbox.organizationId, outbox.runId, new Date());
        await this.#store.cancelOutboxRecord(outbox.organizationId, outbox.outboxId, this.#owner);
        return true;
      }
      await this.#queue.add(
        REMOTE_RUN_JOB_NAME,
        { schemaVersion: 1, runId: outbox.runId, attempt: outbox.attempt, executionGrant: issued.executionGrant },
        { jobId: queueJobId },
      );
      await this.#store.replaceRunAttempt({ ...attempt, status: 'queued', updatedAt: new Date() });
      await this.#store.markOutboxPublished(
        outbox.organizationId,
        outbox.outboxId,
        this.#owner,
        queueJobId,
        new Date(),
      );
      await this.#audit.record({
        requestId: outbox.outboxId,
        organizationId: outbox.organizationId,
        action: 'run.dispatch',
        resourceType: 'run',
        resourceId: outbox.runId,
        outcome: 'succeeded',
        status: 202,
      });
    } catch {
      await this.#store.releaseOutbox(
        outbox.organizationId,
        outbox.outboxId,
        this.#owner,
        new Date(Date.now() + this.#config.retryDelayMs),
      );
      await this.#audit.record({
        requestId: outbox.outboxId,
        organizationId: outbox.organizationId,
        action: 'run.dispatch',
        resourceType: 'run',
        resourceId: outbox.runId,
        outcome: 'failed',
        status: 503,
        errorCode: 'DISPATCH_UNAVAILABLE',
      });
    }
    return true;
  }

  async reapOnce(): Promise<number> {
    if (!this.#queue) return 0;
    const now = new Date();
    const attempts = await this.#store.listRecoverableRunAttempts(
      now,
      new Date(now.getTime() - this.#config.attemptRecoveryMs),
      100,
    );
    for (const attempt of attempts) {
      const run = await this.#store.findRun(attempt.organizationId, attempt.runId);
      if (!run || terminalStatuses.has(run.value.status)) {
        await this.#store.closeRunAttempt(
          attempt.organizationId,
          attempt.runId,
          attempt.attempt,
          'abandoned',
          now,
          'RUN_TERMINAL',
        );
        continue;
      }
      const job = await this.#queue.getJob(attempt.queueJobId);
      if (job) {
        try {
          await job.remove();
        } catch {
          continue;
        }
      }
      await this.#recover(attempt, attempt.status === 'leased' ? 'LEASE_EXPIRED' : 'ATTEMPT_STALE');
    }
    return attempts.length;
  }

  async #retry(outbox: OutboxRecord, attempt: RunAttemptRecord, failureCode: string): Promise<void> {
    await this.#store.cancelOutboxRecord(outbox.organizationId, outbox.outboxId, this.#owner);
    await this.#recover(attempt, failureCode);
  }

  async #recover(attempt: RunAttemptRecord, failureCode: string): Promise<void> {
    const now = new Date();
    if (
      !(await this.#store.closeRunAttempt(
        attempt.organizationId,
        attempt.runId,
        attempt.attempt,
        'abandoned',
        now,
        failureCode,
      ))
    ) {
      return;
    }
    await this.#store.revokeRunGrants(attempt.organizationId, attempt.runId, now);
    if (attempt.attempt >= this.#config.maxAttempts) {
      await this.#audit.record({
        requestId: randomUUID(),
        organizationId: attempt.organizationId,
        action: 'run.retry.exhausted',
        resourceType: 'run',
        resourceId: attempt.runId,
        outcome: 'failed',
        status: 503,
        errorCode: failureCode,
      });
      await this.#controlPlane.failDispatch(attempt.organizationId, attempt.runId, attempt.attempt, 'HARNESS_FAILED');
      return;
    }
    await this.#audit.record({
      requestId: randomUUID(),
      organizationId: attempt.organizationId,
      action: 'run.retry',
      resourceType: 'run',
      resourceId: attempt.runId,
      outcome: 'succeeded',
      status: 202,
      errorCode: failureCode,
    });
    await this.#store.insertOutbox({
      organizationId: attempt.organizationId,
      outboxId: randomUUID(),
      runId: attempt.runId,
      attempt: attempt.attempt + 1,
      kind: 'run.requested',
      status: 'pending',
      availableAt: new Date(now.getTime() + this.#config.retryDelayMs * 2 ** (attempt.attempt - 1)),
      createdAt: now,
    });
  }
}
