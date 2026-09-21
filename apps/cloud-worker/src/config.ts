import path from 'node:path';

import { assertRedisUrl } from '@yanbot-harness/cloud-queue';
import { z } from 'zod';

const positiveInteger = (fallback: number) => z.coerce.number().int().positive().default(fallback);
const environmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    WORKER_REDIS_URL: z.string().trim().min(1),
    WORKER_QUEUE_NAME: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,64}$/u)
      .default('yanbot-harness-remote'),
    WORKER_INTERNAL_ORIGIN: z.string().url(),
    WORKER_ID: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{1,128}$/u),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(2),
    WORKER_HEARTBEAT_MS: positiveInteger(5_000),
    WORKER_INTERACTION_POLL_MS: positiveInteger(500),
    WORKER_RUN_TIMEOUT_MS: positiveInteger(900_000),
    WORKER_SHUTDOWN_MS: positiveInteger(30_000),
    WORKER_SHARED_WORKSPACE_ROOT: z.string().trim().min(1),
    WORKER_TEST_SCENARIO: z.enum(['text', 'question', 'wait-for-cancel']).optional(),
  })
  .strict();

export type WorkerConfig = {
  nodeEnv: 'development' | 'test' | 'production';
  redisUrl: string;
  queueName: string;
  internalOrigin: string;
  workerId: string;
  concurrency: number;
  heartbeatMs: number;
  interactionPollMs: number;
  runTimeoutMs: number;
  shutdownMs: number;
  sharedWorkspaceRoot: string;
  testScenario?: 'text' | 'question' | 'wait-for-cancel';
};

export function parseWorkerConfig(environment: NodeJS.ProcessEnv): WorkerConfig {
  const value = environmentSchema.parse(
    Object.fromEntries(
      Object.entries(environment).filter(([name]) => name === 'NODE_ENV' || name.startsWith('WORKER_')),
    ),
  );
  const origin = new URL(value.WORKER_INTERNAL_ORIGIN);
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') {
    throw new Error('The Worker internal origin is invalid.');
  }
  if (value.NODE_ENV === 'production' && origin.protocol !== 'https:') {
    throw new Error('Production Worker requires an HTTPS internal origin.');
  }
  if (!['http:', 'https:'].includes(origin.protocol)) throw new Error('The Worker internal origin is invalid.');
  if (value.WORKER_TEST_SCENARIO && value.NODE_ENV !== 'test') {
    throw new Error('Reference test scenarios are only available in test mode.');
  }
  if (value.WORKER_HEARTBEAT_MS >= value.WORKER_RUN_TIMEOUT_MS) {
    throw new Error('The Worker heartbeat interval must be shorter than the Run timeout.');
  }
  const sharedWorkspaceRoot = path.resolve(value.WORKER_SHARED_WORKSPACE_ROOT);
  if (sharedWorkspaceRoot === path.parse(sharedWorkspaceRoot).root) {
    throw new Error('The shared workspace root cannot be a filesystem root.');
  }
  return {
    nodeEnv: value.NODE_ENV,
    redisUrl: assertRedisUrl(value.WORKER_REDIS_URL, value.NODE_ENV === 'production'),
    queueName: value.WORKER_QUEUE_NAME,
    internalOrigin: origin.toString().replace(/\/$/u, ''),
    workerId: value.WORKER_ID,
    concurrency: value.WORKER_CONCURRENCY,
    heartbeatMs: value.WORKER_HEARTBEAT_MS,
    interactionPollMs: value.WORKER_INTERACTION_POLL_MS,
    runTimeoutMs: value.WORKER_RUN_TIMEOUT_MS,
    shutdownMs: value.WORKER_SHUTDOWN_MS,
    sharedWorkspaceRoot,
    ...(value.WORKER_TEST_SCENARIO === undefined ? {} : { testScenario: value.WORKER_TEST_SCENARIO }),
  };
}
