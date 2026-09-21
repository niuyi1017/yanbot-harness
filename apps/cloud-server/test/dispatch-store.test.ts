import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { OutboxRecord, RunAttemptRecord } from '../src/domain.js';
import { MemoryControlPlaneStore } from '../src/persistence/memory.store.js';

describe('Dispatch persistence state machine', () => {
  it('leases pending outbox records, rejects a competing owner and permits expiry recovery', async () => {
    const store = new MemoryControlPlaneStore();
    const now = new Date('2026-09-21T00:00:00.000Z');
    const record = outbox(now);
    await store.insertOutbox(record);

    await expect(store.claimDispatchOutbox('relay-a', now, plus(now, 30_000))).resolves.toMatchObject({
      outboxId: record.outboxId,
      status: 'publishing',
      leaseOwner: 'relay-a',
    });
    await expect(store.claimDispatchOutbox('relay-b', plus(now, 1), plus(now, 30_001))).resolves.toBeUndefined();
    await expect(store.claimDispatchOutbox('relay-b', plus(now, 30_000), plus(now, 60_000))).resolves.toMatchObject({
      leaseOwner: 'relay-b',
    });
    await expect(
      store.markOutboxPublished(record.organizationId, record.outboxId, 'relay-a', 'wrong', plus(now, 30_001)),
    ).resolves.toBe(false);
    await expect(
      store.markOutboxPublished(
        record.organizationId,
        record.outboxId,
        'relay-b',
        `run-${record.runId}-attempt-1`,
        plus(now, 30_001),
      ),
    ).resolves.toBe(true);
  });

  it('enforces one active attempt and worker-bound, non-resurrecting leases', async () => {
    const store = new MemoryControlPlaneStore();
    const now = new Date('2026-09-21T00:00:00.000Z');
    const record = attempt(now);
    await store.insertRunAttempt(record);
    await expect(
      store.insertRunAttempt({ ...record, attempt: 2, queueJobId: `${record.queueJobId}-2` }),
    ).rejects.toThrow('conflicts');
    await expect(
      store.claimRunAttempt(record.organizationId, record.runId, 1, 'worker-a', now, plus(now, 30_000)),
    ).resolves.toMatchObject({ status: 'leased', workerId: 'worker-a' });
    await expect(
      store.heartbeatRunAttempt(
        record.organizationId,
        record.runId,
        1,
        'worker-b',
        plus(now, 1_000),
        plus(now, 31_000),
      ),
    ).resolves.toBe(false);
    await expect(store.listRecoverableRunAttempts(plus(now, 30_000), now, 10)).resolves.toHaveLength(1);
    await expect(
      store.heartbeatRunAttempt(
        record.organizationId,
        record.runId,
        1,
        'worker-a',
        plus(now, 30_000),
        plus(now, 60_000),
      ),
    ).resolves.toBe(false);
  });
});

function outbox(now: Date): OutboxRecord {
  return {
    organizationId: randomUUID(),
    outboxId: randomUUID(),
    runId: randomUUID(),
    attempt: 1,
    kind: 'run.requested',
    status: 'pending',
    availableAt: now,
    createdAt: now,
  };
}

function attempt(now: Date): RunAttemptRecord {
  const runId = randomUUID();
  return {
    organizationId: randomUUID(),
    runId,
    attempt: 1,
    queueJobId: `run-${runId}-attempt-1`,
    status: 'queued',
    active: true,
    createdAt: now,
    updatedAt: now,
  };
}

function plus(value: Date, milliseconds: number): Date {
  return new Date(value.getTime() + milliseconds);
}
