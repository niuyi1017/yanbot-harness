import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { z } from 'zod';

import { uuidSchema } from '@yanbot-harness/contracts';

export const REMOTE_RUN_JOB_NAME = 'remote-reference-run';
export const remoteRunJobSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: uuidSchema,
    attempt: z.number().int().min(1).max(100),
    executionGrant: z.string().regex(/^yhe_[A-Za-z0-9_-]{43}$/u),
  })
  .strict();

export type RemoteRunJob = z.infer<typeof remoteRunJobSchema>;

export function remoteRunJobId(runIdValue: unknown, attemptValue: unknown): string {
  const runId = uuidSchema.parse(runIdValue);
  const attempt = z.number().int().min(1).max(100).parse(attemptValue);
  return `run-${runId}-attempt-${attempt}`;
}

export function assertRedisUrl(value: string, production = false): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('The Redis connection URL is invalid.');
  }
  if (!['redis:', 'rediss:'].includes(url.protocol) || url.hash || url.search || !url.hostname) {
    throw new Error('The Redis connection URL is invalid.');
  }
  if (production && url.protocol !== 'rediss:') throw new Error('Production Redis requires TLS.');
  return url.toString();
}

export function createQueueConnection(redisUrl: string): Redis {
  return new Redis(assertRedisUrl(redisUrl), {
    enableReadyCheck: true,
    lazyConnect: true,
    maxRetriesPerRequest: null,
  });
}

export function createRemoteRunQueue(queueName: string, connection: Redis): Queue<RemoteRunJob> {
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(queueName)) throw new Error('The Remote queue name is invalid.');
  return new Queue<RemoteRunJob>(queueName, {
    connection,
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: { age: 86_400, count: 10_000 },
      removeOnFail: { age: 604_800, count: 10_000 },
    },
  });
}
