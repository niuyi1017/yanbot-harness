import { describe, expect, it } from 'vitest';

import { parseWorkerConfig } from '../src/config.js';

const base = {
  NODE_ENV: 'test',
  WORKER_REDIS_URL: 'redis://127.0.0.1:6379',
  WORKER_INTERNAL_ORIGIN: 'http://127.0.0.1:3878',
  WORKER_ID: 'worker-a',
  WORKER_SHARED_WORKSPACE_ROOT: '/tmp/yanbot-worker-workspaces',
};

describe('Cloud Worker configuration', () => {
  it('requires an immutable sandbox image and explicit opt-in', () => {
    expect(() => parseWorkerConfig({ ...base, WORKER_SANDBOX_IMAGE: 'node:latest' })).toThrow();
    expect(() =>
      parseWorkerConfig({
        ...base,
        WORKER_EXECUTION_MODE: 'sandbox',
        WORKER_DOCKER_PATH: '/usr/bin/docker',
        WORKER_SANDBOX_IMAGE: 'node:latest',
      }),
    ).toThrow();
    expect(
      parseWorkerConfig({
        ...base,
        WORKER_EXECUTION_MODE: 'sandbox',
        WORKER_DOCKER_PATH: '/usr/bin/docker',
        WORKER_SANDBOX_IMAGE: 'sha256:' + 'a'.repeat(64),
      }).sandbox?.image,
    ).toBe('sha256:' + 'a'.repeat(64));
  });

  it('parses bounded defaults', () => {
    expect(parseWorkerConfig({ ...base, PATH: '/usr/bin' })).toMatchObject({
      workerId: 'worker-a',
      concurrency: 2,
      heartbeatMs: 5_000,
      shutdownMs: 30_000,
      queueName: 'yanbot-harness-remote',
    });
    expect(() => parseWorkerConfig({ ...base, WORKER_CONCURRNECY: '4' })).toThrow();
  });

  it('requires TLS transports in production and rejects broad workspace roots', () => {
    expect(() => parseWorkerConfig({ ...base, NODE_ENV: 'production' })).toThrow(/HTTPS/u);
    expect(() =>
      parseWorkerConfig({
        ...base,
        NODE_ENV: 'production',
        WORKER_INTERNAL_ORIGIN: 'https://internal.example.com',
      }),
    ).toThrow(/TLS/u);
    expect(() => parseWorkerConfig({ ...base, WORKER_SHARED_WORKSPACE_ROOT: '/' })).toThrow(/filesystem root/u);
    expect(() => parseWorkerConfig({ ...base, WORKER_HEARTBEAT_MS: '1000', WORKER_RUN_TIMEOUT_MS: '1000' })).toThrow(
      /heartbeat/u,
    );
    expect(() => parseWorkerConfig({ ...base, NODE_ENV: 'production', WORKER_TEST_SCENARIO: 'question' })).toThrow();
  });
});
