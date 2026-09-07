import { mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { ReferenceAdapter } from '@yanbot-harness/adapter-reference';
import {
  HARNESS_PROTOCOL_VERSION,
  type AdapterEvent,
  type CreateLocalRunRequest,
  type LocalRun,
  type LocalSession,
} from '@yanbot-harness/contracts';
import { LocalRuntimeTestClient, collectAsync, createTemporaryStateRoot } from '@yanbot-harness/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { FileLocalStateStore } from '../src/local-state-store.js';
import { startLocalRuntime, type LocalRuntimeHandle } from '../src/server.js';

const cleanups: Array<() => Promise<void>> = [];
const runtimes: LocalRuntimeHandle[] = [];

afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('local runtime end to end', () => {
  it('keeps an interaction alive across SSE disconnect and accepts an idempotent response', async () => {
    const fixture = await workspaceFixture();
    const runtime = await start({
      stateRoot: fixture.stateRoot,
      adapter: new ReferenceAdapter({
        scenario: { kind: 'question', prompt: 'Choose?', answerResult: 'answered' },
      }),
    });
    const client = new LocalRuntimeTestClient(runtime);
    const grant = await client.issueWorkspaceGrant({ path: fixture.workspace });
    const session = await client.createSession({ adapterId: 'cn.yanbot.reference' });
    const created = await client.createRun(session.sessionId, runRequest(grant.grant));
    const iterator = client.events(created.run.runId)[Symbol.asyncIterator]();
    let requested: Extract<AdapterEvent, { type: 'interaction.requested' }> | undefined;
    while (!requested) {
      const item = await iterator.next();
      if (item.done) throw new Error('The run ended before requesting an interaction.');
      if (item.value.type === 'interaction.requested') requested = item.value;
    }
    await iterator.return?.();
    await expect(client.getRun(created.run.runId)).resolves.toMatchObject({ status: 'running' });

    const questionId = requested.payload.kind === 'question' ? requested.payload.questions[0]!.id : '';
    const response = {
      requestId: requested.payload.requestId,
      action: 'submit' as const,
      answers: { [questionId]: 'yes' },
    };
    await Promise.all([client.respond(response), client.respond(response)]);
    const resumedEvents = await collectAsync(client.events(created.run.runId, { afterEventId: requested.eventId }));
    expect(resumedEvents.map((event) => event.type)).toEqual([
      'interaction.resolved',
      'assistant.message',
      'run.completed',
    ]);
    await expect(client.getRun(created.run.runId)).resolves.toMatchObject({ status: 'completed' });
  });

  it('resumes sessions after restart, invalidates old grants, and keeps state free of paths and tokens', async () => {
    const fixture = await workspaceFixture();
    const first = await start({
      stateRoot: fixture.stateRoot,
      adapter: new ReferenceAdapter({ scenario: { kind: 'text', chunks: [`workspace=${fixture.workspace}`] } }),
      accessToken: 'first-runtime-secret',
    });
    const firstClient = new LocalRuntimeTestClient(first);
    const firstGrant = await firstClient.issueWorkspaceGrant({ path: fixture.workspace });
    const session = await firstClient.createSession({ adapterId: 'cn.yanbot.reference' });
    const firstRun = await firstClient.createRun(session.sessionId, runRequest(firstGrant.grant));
    const firstEvents = await collectAsync(firstClient.events(firstRun.run.runId));
    const serializedEvents = JSON.stringify(firstEvents);
    expect(serializedEvents).toMatch(/\[(?:WORKSPACE|REDACTED_PATH)\]/u);
    expect(serializedEvents).not.toContain(fixture.workspace);
    await first.close();

    const second = await start({
      stateRoot: fixture.stateRoot,
      adapter: new ReferenceAdapter({ scenario: { kind: 'text', chunks: ['resumed'] } }),
      accessToken: 'second-runtime-secret',
    });
    const secondClient = new LocalRuntimeTestClient(second);
    await expect(secondClient.listSessions()).resolves.toMatchObject([{ sessionId: session.sessionId }]);
    await expect(secondClient.getRun(firstRun.run.runId)).resolves.toMatchObject({ status: 'completed' });
    await expect(
      secondClient.createRun(session.sessionId, { ...runRequest(firstGrant.grant), resume: true }),
    ).rejects.toThrow('HTTP 403');
    const secondGrant = await secondClient.issueWorkspaceGrant({ path: fixture.workspace });
    const resumed = await secondClient.createRun(session.sessionId, {
      ...runRequest(secondGrant.grant),
      resume: true,
    });
    expect((await collectAsync(secondClient.events(resumed.run.runId))).at(-1)?.type).toBe('run.completed');
    await second.close();

    const persisted = await readTree(fixture.stateRoot);
    expect(persisted).not.toContain(fixture.workspace);
    expect(persisted).not.toContain('first-runtime-secret');
    expect(persisted).not.toContain('second-runtime-secret');
  });

  it('produces one terminal event for explicit cancellation and run timeout', async () => {
    const fixture = await workspaceFixture();
    const runtime = await start({
      stateRoot: fixture.stateRoot,
      adapter: new ReferenceAdapter({ scenario: { kind: 'wait-for-cancel' } }),
      runTimeoutMs: 250,
    });
    const client = new LocalRuntimeTestClient(runtime);
    const grant = await client.issueWorkspaceGrant({ path: fixture.workspace });
    const cancelledSession = await client.createSession({ adapterId: 'cn.yanbot.reference' });
    const cancelled = await client.createRun(cancelledSession.sessionId, runRequest(grant.grant));
    await client.cancelRun(cancelled.run.runId, 'Explicit cancellation.');
    const cancelledEvents = await collectAsync(client.events(cancelled.run.runId));
    expect(cancelledEvents.filter(isTerminal)).toHaveLength(1);
    expect(cancelledEvents.at(-1)).toMatchObject({
      type: 'run.cancelled',
      payload: { reason: 'Explicit cancellation.' },
    });

    const timeoutSession = await client.createSession({ adapterId: 'cn.yanbot.reference' });
    const timedOut = await client.createRun(timeoutSession.sessionId, runRequest(grant.grant));
    const timeoutEvents = await collectAsync(client.events(timedOut.run.runId));
    expect(timeoutEvents.filter(isTerminal)).toHaveLength(1);
    expect(timeoutEvents.at(-1)).toMatchObject({
      type: 'run.cancelled',
      payload: { reason: 'The local run timed out.' },
    });
  });

  it('exposes an interrupted terminal state after restarting incomplete durable state', async () => {
    const fixture = await workspaceFixture();
    const sessionId = '11111111-1111-4111-8111-111111111111';
    const runId = '22222222-2222-4222-8222-222222222222';
    const timestamp = '2026-09-07T12:00:00.000Z';
    const store = new FileLocalStateStore({ stateRoot: fixture.stateRoot });
    await store.initialize();
    await store.createSession(session(sessionId, timestamp));
    await store.createRun(run(runId, sessionId, timestamp));
    await store.appendEvent({
      protocolVersion: HARNESS_PROTOCOL_VERSION,
      eventId: '33333333-3333-4333-8333-333333333333',
      runId,
      sessionId,
      sequence: 1,
      timestamp,
      type: 'run.started',
      payload: { adapterId: 'cn.yanbot.reference' },
    });

    const runtime = await start({ stateRoot: fixture.stateRoot, adapter: new ReferenceAdapter() });
    const client = new LocalRuntimeTestClient(runtime);
    await expect(client.getRun(runId)).resolves.toMatchObject({
      status: 'interrupted',
      terminalEventType: 'run.failed',
    });
    const events = await collectAsync(client.events(runId));
    expect(events).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ type: 'run.failed', payload: { error: { code: 'INTERNAL_ERROR' } } });
  });
});

async function workspaceFixture(): Promise<{ stateRoot: string; workspace: string }> {
  const temporary = await createTemporaryStateRoot('yanbot-harness-e2e-');
  cleanups.push(temporary.cleanup);
  const workspace = path.join(temporary.path, 'workspace');
  await mkdir(workspace);
  return { stateRoot: path.join(temporary.path, 'state'), workspace };
}

async function start(options: {
  stateRoot: string;
  adapter: ReferenceAdapter;
  accessToken?: string;
  runTimeoutMs?: number;
}): Promise<{ origin: string; accessToken: string; close(): Promise<void> }> {
  const runtime = await startLocalRuntime({
    stateRoot: options.stateRoot,
    adapters: [options.adapter],
    ...(options.accessToken === undefined ? {} : { accessToken: options.accessToken }),
    ...(options.runTimeoutMs === undefined ? {} : { runTimeoutMs: options.runTimeoutMs }),
  });
  runtimes.push(runtime);
  return runtime;
}

function runRequest(workspaceGrant: string): CreateLocalRunRequest {
  return {
    prompt: 'Run through the public local protocol.',
    workspaceGrant,
    permissionPolicy: 'interactive',
    configScopes: [],
    extensions: [],
    resume: false,
  };
}

function session(sessionId: string, timestamp: string): LocalSession {
  return {
    protocolVersion: HARNESS_PROTOCOL_VERSION,
    sessionId,
    adapterId: 'cn.yanbot.reference',
    status: 'running',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function run(runId: string, sessionId: string, timestamp: string): LocalRun {
  return {
    protocolVersion: HARNESS_PROTOCOL_VERSION,
    runId,
    sessionId,
    adapterId: 'cn.yanbot.reference',
    status: 'running',
    prompt: 'Interrupted prompt.',
    permissionPolicy: 'interactive',
    createdAt: timestamp,
  };
}

function isTerminal(event: AdapterEvent): boolean {
  return event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.cancelled';
}

async function readTree(root: string): Promise<string> {
  const entries = await readdir(root, { withFileTypes: true });
  const values: string[] = [];
  for (const entry of entries) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) values.push(await readTree(file));
    else values.push(await readFile(file, 'utf8'));
  }
  return values.join('\n');
}
