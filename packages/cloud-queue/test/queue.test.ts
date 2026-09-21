import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  REMOTE_RUN_JOB_NAME,
  assertRedisUrl,
  createQueueConnection,
  createRemoteRunQueue,
  remoteRunJobId,
  remoteRunJobSchema,
} from '../src/index.js';

describe('cloud queue', () => {
  it('accepts only the minimal strict job payload and deterministic safe ID', () => {
    const runId = '11111111-1111-4111-8111-111111111111';
    expect(
      remoteRunJobSchema.parse({
        schemaVersion: 1,
        runId,
        attempt: 2,
        executionGrant: `yhe_${'a'.repeat(43)}`,
      }),
    ).toBeDefined();
    expect(remoteRunJobId(runId, 2)).toBe(`run-${runId}-attempt-2`);
    expect(() =>
      remoteRunJobSchema.parse({
        schemaVersion: 1,
        runId,
        attempt: 2,
        executionGrant: `yhe_${'a'.repeat(43)}`,
        prompt: 'must not enter Redis',
      }),
    ).toThrow();
  });

  it('requires TLS for production without reflecting credentials', () => {
    expect(assertRedisUrl('rediss://user:secret@redis.example.test:6380/0', true)).toContain('rediss:');
    for (const value of ['redis://redis.example.test:6379', 'https://redis.example.test', 'not-a-url']) {
      const error = catchError(() => assertRedisUrl(value, true));
      expect(String(error)).not.toContain(value);
      expect(String(error)).not.toContain('secret');
    }
  });
});

describe('cloud queue Redis integration', () => {
  let redis: Awaited<ReturnType<typeof startRedis>>;

  beforeAll(async () => {
    redis = await startRedis();
  });

  afterAll(async () => {
    await redis.close();
  });

  it('deduplicates a deterministic job ID', async () => {
    const connection = createQueueConnection(redis.url);
    await connection.connect();
    const queue = createRemoteRunQueue(`worker-test-${process.pid}`, connection);
    const data = remoteRunJobSchema.parse({
      schemaVersion: 1,
      runId: '22222222-2222-4222-8222-222222222222',
      attempt: 1,
      executionGrant: `yhe_${'b'.repeat(43)}`,
    });
    const jobId = remoteRunJobId(data.runId, data.attempt);
    try {
      const first = await queue.add(REMOTE_RUN_JOB_NAME, data, { jobId });
      const second = await queue.add(REMOTE_RUN_JOB_NAME, data, { jobId });
      expect(first.id).toBe(jobId);
      expect(second.id).toBe(jobId);
      expect(await queue.getJobCounts('wait', 'active', 'delayed')).toMatchObject({ wait: 1, active: 0, delayed: 0 });
    } finally {
      await queue.obliterate({ force: true });
      await queue.close();
      await connection.quit();
    }
  });

  it('reconnects cleanly after a data-loss restart so the control plane can rebuild jobs', async () => {
    const firstConnection = createQueueConnection(redis.url);
    await firstConnection.connect();
    const firstQueue = createRemoteRunQueue(`restart-test-${process.pid}`, firstConnection);
    const data = remoteRunJobSchema.parse({
      schemaVersion: 1,
      runId: '33333333-3333-4333-8333-333333333333',
      attempt: 1,
      executionGrant: `yhe_${'c'.repeat(43)}`,
    });
    await firstQueue.add(REMOTE_RUN_JOB_NAME, data, { jobId: remoteRunJobId(data.runId, data.attempt) });
    await firstQueue.close();
    await firstConnection.quit();

    await redis.restart();

    const secondConnection = createQueueConnection(redis.url);
    await secondConnection.connect();
    const secondQueue = createRemoteRunQueue(`restart-test-${process.pid}`, secondConnection);
    try {
      expect(await secondQueue.getJobCounts('wait', 'active', 'delayed')).toMatchObject({
        wait: 0,
        active: 0,
        delayed: 0,
      });
    } finally {
      await secondQueue.obliterate({ force: true });
      await secondQueue.close();
      await secondConnection.quit();
    }
  });
});

async function startRedis(): Promise<{ url: string; restart(): Promise<void>; close(): Promise<void> }> {
  const port = await availablePort();
  const directory = await mkdtemp(path.join(tmpdir(), 'yanbot-cloud-queue-'));
  const url = `redis://127.0.0.1:${port}/0`;
  let child = launchRedis(port, directory);
  await waitForRedis(child, url);
  return {
    url,
    async restart() {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child = launchRedis(port, directory);
      await waitForRedis(child, url);
    },
    async close() {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function launchRedis(port: number, directory: string): ChildProcess {
  return spawn(
    'redis-server',
    ['--bind', '127.0.0.1', '--port', String(port), '--save', '', '--appendonly', 'no', '--dir', directory],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

async function waitForRedis(child: ChildProcess, url: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('The temporary Redis process exited before readiness.');
    const connection = createQueueConnection(url);
    connection.on('error', () => undefined);
    try {
      await connection.connect();
      await connection.ping();
      await connection.quit();
      return;
    } catch {
      connection.disconnect();
      await delay(25);
    }
  }
  throw new Error('The temporary Redis process did not become ready.');
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('Unable to allocate a Redis test port.');
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function catchError(operation: () => unknown): unknown {
  try {
    operation();
    return undefined;
  } catch (error) {
    return error;
  }
}
