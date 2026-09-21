import { randomUUID } from 'node:crypto';

import { ReferenceAdapter, type ReferenceScenario } from '@yanbot-harness/adapter-reference';
import {
  HARNESS_PROTOCOL_VERSION,
  runSchema,
  type AdapterEvent,
  type InteractionResponse,
} from '@yanbot-harness/contracts';
import { describe, expect, it } from 'vitest';

import type { WorkerConfig } from '../src/config.js';
import { InternalClientError, type WorkerWorkspace } from '../src/internal-client.js';
import { RunCoordinator, type WorkerControlPlaneClient } from '../src/run-coordinator.js';

describe('Remote Reference run coordinator', () => {
  it.each([
    [{ kind: 'text', chunks: ['remote ', 'text'] }, ['assistant.delta', 'assistant.message', 'run.completed']],
    [{ kind: 'tool', toolName: 'read', result: { ok: true } }, ['tool.started', 'tool.completed', 'run.completed']],
    [{ kind: 'failure', code: 'HARNESS_FAILED' }, ['run.failed']],
  ] satisfies Array<[ReferenceScenario, string[]]>)(
    'executes the %s scenario through public Adapter boundaries',
    async (scenario, expected) => {
      const fixture = createFixture(scenario);
      await fixture.coordinator.process(fixture.job);
      expect(fixture.client.events.map((event) => event.type)).toEqual(expect.arrayContaining(expected));
      expect(fixture.client.events[0]?.type).toBe('run.started');
      expect(fixture.client.events.at(-1)?.type).toMatch(/^run\.(completed|failed)$/u);
    },
  );

  it('pumps an interaction response without placing it in the queue job', async () => {
    const fixture = createFixture({ kind: 'question', prompt: 'Choose?', answerResult: 'answered' });
    fixture.client.response = {
      requestId: `question:${fixture.job.runId}`,
      action: 'submit',
      answers: { [`question-item:${fixture.job.runId}`]: 'yes' },
    };
    await fixture.coordinator.process(fixture.job);
    expect(fixture.client.events.map((event) => event.type)).toContain('interaction.resolved');
    expect(fixture.client.events.at(-1)?.type).toBe('run.completed');
  });

  it('rejects Git execution without a sandbox using a stable terminal failure', async () => {
    const fixture = createFixture({ kind: 'text', chunks: ['unused'] });
    fixture.client.workspaceValue = {
      workspaceRef: randomUUID(),
      source: { kind: 'git-ref', repository: 'https://github.com/example/repo.git', ref: 'a'.repeat(40) },
    };
    await expect(fixture.coordinator.process(fixture.job)).rejects.toThrow('isolated sandbox');
    expect(fixture.client.events.at(-1)).toMatchObject({
      type: 'run.failed',
      payload: { error: { code: 'CONFIGURATION_INVALID' } },
    });
  });

  it('turns a bounded execution timeout into RUN_TIMEOUT', async () => {
    const fixture = createFixture({ kind: 'wait-for-cancel' }, { runTimeoutMs: 5, heartbeatMs: 100 });
    await fixture.coordinator.process(fixture.job);
    expect(fixture.client.events.at(-1)).toMatchObject({
      type: 'run.failed',
      payload: { error: { code: 'RUN_TIMEOUT' } },
    });
  });

  it('stops without a late event after losing its worker-bound lease', async () => {
    const fixture = createFixture({ kind: 'wait-for-cancel' }, { heartbeatMs: 1, runTimeoutMs: 1_000 });
    fixture.client.failHeartbeat = true;
    await fixture.coordinator.process(fixture.job);
    expect(fixture.client.events.some((event) => event.type === 'run.completed')).toBe(false);
  });
});

class FakeClient implements WorkerControlPlaneClient {
  readonly events: AdapterEvent[] = [];
  response: InteractionResponse | undefined;
  failHeartbeat = false;
  readonly runValue = runSchema.parse({
    protocolVersion: HARNESS_PROTOCOL_VERSION,
    runId: randomUUID(),
    sessionId: randomUUID(),
    adapterId: 'cn.yanbot.reference',
    status: 'queued',
    prompt: 'worker prompt',
    permissionPolicy: 'interactive',
    createdAt: new Date().toISOString(),
  });
  workspaceValue: WorkerWorkspace = {
    workspaceRef: randomUUID(),
    source: { kind: 'uploaded-snapshot' as const, uploadId: randomUUID(), digest: `sha256:${'a'.repeat(64)}` },
    storageKey: `${randomUUID()}/${randomUUID()}`,
  };

  async claim(): Promise<void> {}
  async run() {
    return this.runValue;
  }
  async workspace() {
    return this.workspaceValue;
  }
  async heartbeat(): Promise<void> {
    if (this.failHeartbeat) throw new InternalClientError(403);
  }
  async interaction(): Promise<InteractionResponse | undefined> {
    return this.response;
  }
  async append(_runId: string, _attempt: number, value: AdapterEvent): Promise<void> {
    this.events.push(value);
  }
}

function createFixture(scenario: ReferenceScenario, overrides: Partial<WorkerConfig> = {}) {
  const client = new FakeClient();
  const config: WorkerConfig = {
    nodeEnv: 'test',
    redisUrl: 'redis://127.0.0.1:6379',
    queueName: 'test-remote',
    internalOrigin: 'http://127.0.0.1:3878',
    workerId: 'worker-a',
    concurrency: 1,
    heartbeatMs: 10,
    interactionPollMs: 1,
    runTimeoutMs: 1_000,
    shutdownMs: 1_000,
    sharedWorkspaceRoot: '/tmp/yanbot-worker-workspaces',
    ...overrides,
  };
  const coordinator = new RunCoordinator(
    config,
    () => client,
    () => new ReferenceAdapter({ scenario }),
  );
  const job = {
    schemaVersion: 1 as const,
    runId: client.runValue.runId,
    attempt: 1,
    executionGrant: `yhe_${'a'.repeat(43)}`,
  };
  return { client, coordinator, job };
}
