import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ReferenceAdapter, type ReferenceScenario } from '@yanbot-harness/adapter-reference';
import type { AdapterEvent } from '@yanbot-harness/contracts';
import type { DiscoveredExtension } from '@yanbot-harness/extension-kit';
import { afterEach, describe, expect, it } from 'vitest';

import { LocalAdapterService } from '../src/adapters.js';
import { LocalEventHub } from '../src/event-hub.js';
import { FileLocalStateStore } from '../src/local-state-store.js';
import { RunSupervisor } from '../src/run-supervisor.js';
import { WorkspaceGrantRegistry } from '../src/workspace-grants.js';

const roots: string[] = [];
const timestamp = new Date('2026-09-07T10:00:00.000Z');

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe('RunSupervisor', () => {
  it('runs the reference adapter and persists terminal session state', async () => {
    const fixture = await setup({ kind: 'text', chunks: ['hello', ' world'] });
    const session = await fixture.supervisor.createSession({ adapterId: 'cn.yanbot.reference', title: 'Local' });
    const grant = await fixture.grants.issue(fixture.workspace);
    const { run } = await fixture.supervisor.createRun(session.sessionId, request(grant.grant), 'request-1');

    const events = await collect(fixture.supervisor.events(run.runId));
    expect(events.map((event) => event.type)).toEqual([
      'run.started',
      'session.initialized',
      'assistant.delta',
      'assistant.delta',
      'assistant.message',
      'usage.updated',
      'run.completed',
    ]);
    await expect(fixture.supervisor.getRun(run.runId)).resolves.toMatchObject({
      status: 'completed',
      terminalEventType: 'run.completed',
    });
    await expect(fixture.supervisor.getSession(session.sessionId)).resolves.toMatchObject({
      status: 'idle',
      adapterSessionId: `reference:${session.sessionId}`,
    });

    const resumed = await fixture.supervisor.createRun(session.sessionId, { ...request(grant.grant), resume: true });
    expect((await collect(fixture.supervisor.events(resumed.run.runId))).at(-1)?.type).toBe('run.completed');
  });

  it('deduplicates identical run creation and rejects conflicting idempotency reuse', async () => {
    const fixture = await setup({ kind: 'wait-for-cancel' });
    const session = await fixture.supervisor.createSession({ adapterId: 'cn.yanbot.reference' });
    const grant = await fixture.grants.issue(fixture.workspace);
    const input = request(grant.grant);
    const first = await fixture.supervisor.createRun(session.sessionId, input, 'same-key');
    const second = await fixture.supervisor.createRun(session.sessionId, input, 'same-key');
    expect(second).toEqual({ run: first.run, reused: true });
    await expect(
      fixture.supervisor.createRun(session.sessionId, { ...input, prompt: 'Different' }, 'same-key'),
    ).rejects.toMatchObject({ status: 409 });
    await expect(fixture.supervisor.createRun(session.sessionId, input)).rejects.toMatchObject({ status: 409 });
    await fixture.supervisor.cancelRun(first.run.runId);
    await collect(fixture.supervisor.events(first.run.runId));
  });

  it('exposes interactive permissions and accepts an idempotent response', async () => {
    const fixture = await setup({ kind: 'permission', toolName: 'Bash', allowResult: 'approved' });
    const session = await fixture.supervisor.createSession({ adapterId: 'cn.yanbot.reference' });
    const grant = await fixture.grants.issue(fixture.workspace);
    const { run } = await fixture.supervisor.createRun(session.sessionId, request(grant.grant));
    const iterator = fixture.supervisor.events(run.runId)[Symbol.asyncIterator]();
    const seen: AdapterEvent[] = [];
    let requested: Extract<AdapterEvent, { type: 'interaction.requested' }> | undefined;
    while (!requested) {
      const item = await iterator.next();
      if (item.done) throw new Error('The interaction stream ended early.');
      seen.push(item.value);
      if (item.value.type === 'interaction.requested') requested = item.value;
    }
    const response = { requestId: requested.payload.requestId, action: 'allow' as const };
    await Promise.all([
      fixture.supervisor.respondToInteraction(response),
      fixture.supervisor.respondToInteraction(response),
    ]);
    while (true) {
      const item = await iterator.next();
      if (item.done) break;
      seen.push(item.value);
    }
    expect(seen.map((event) => event.type)).toContain('run.completed');
    await expect(fixture.supervisor.respondToInteraction({ ...response, action: 'deny' })).rejects.toMatchObject({
      status: 409,
    });
  });

  it('rejects extensions when the selected adapter does not declare the capability', async () => {
    const extension: DiscoveredExtension = {
      descriptor: {
        extensionId: 'example.skill',
        kind: 'skill',
        version: '1.0.0',
        displayName: 'Example',
        source: 'project',
        requiredCapabilities: ['extensions.skills'],
        credentialRefs: [],
      },
      resourcePath: '/private/extension/SKILL.md',
    };
    const fixture = await setup({ kind: 'text', chunks: ['unused'] }, [extension]);
    const session = await fixture.supervisor.createSession({ adapterId: 'cn.yanbot.reference' });
    const grant = await fixture.grants.issue(fixture.workspace);

    await expect(
      fixture.supervisor.createRun(session.sessionId, {
        ...request(grant.grant),
        extensions: [{ extensionId: 'example.skill', enabled: true }],
      }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
  });

  it('cancels runs and denies pending interactions when their deadlines expire', async () => {
    const timedRun = await setup({ kind: 'wait-for-cancel' }, [], { runTimeoutMs: 10 });
    const runSession = await timedRun.supervisor.createSession({ adapterId: 'cn.yanbot.reference' });
    const runGrant = await timedRun.grants.issue(timedRun.workspace);
    const { run } = await timedRun.supervisor.createRun(runSession.sessionId, request(runGrant.grant));
    expect((await collect(timedRun.supervisor.events(run.runId))).at(-1)?.type).toBe('run.cancelled');

    const timedInteraction = await setup({ kind: 'permission', toolName: 'Bash', allowResult: 'unused' }, [], {
      interactionTimeoutMs: 10,
    });
    const interactionSession = await timedInteraction.supervisor.createSession({
      adapterId: 'cn.yanbot.reference',
    });
    const interactionGrant = await timedInteraction.grants.issue(timedInteraction.workspace);
    const interactionRun = await timedInteraction.supervisor.createRun(
      interactionSession.sessionId,
      request(interactionGrant.grant),
    );
    const events = await collect(timedInteraction.supervisor.events(interactionRun.run.runId));
    expect(events.map((event) => event.type)).toContain('interaction.resolved');
    expect(events.at(-1)?.type).toBe('run.failed');
  });
});

async function setup(
  scenario: ReferenceScenario,
  extensions: readonly DiscoveredExtension[] = [],
  limits: { runTimeoutMs?: number; interactionTimeoutMs?: number; maxConcurrentRuns?: number } = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), 'yanbot-harness-supervisor-'));
  roots.push(root);
  const workspace = path.join(root, 'workspace');
  const stateRoot = path.join(root, 'state');
  await mkdir(workspace);
  const store = new FileLocalStateStore({ stateRoot, now: () => timestamp });
  await store.initialize();
  const grants = new WorkspaceGrantRegistry();
  const supervisor = new RunSupervisor({
    store,
    eventHub: new LocalEventHub(store),
    adapters: new LocalAdapterService({ adapters: [new ReferenceAdapter({ scenario, now: () => timestamp })] }),
    workspaceGrants: grants,
    extensions,
    ...limits,
    now: () => timestamp,
  });
  return { supervisor, grants, workspace };
}

function request(workspaceGrant: string) {
  return {
    prompt: 'Run locally',
    workspaceGrant,
    permissionPolicy: 'interactive' as const,
    configScopes: [],
    extensions: [],
    resume: false,
  };
}

async function collect(events: AsyncIterable<AdapterEvent>): Promise<AdapterEvent[]> {
  const collected: AdapterEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}
