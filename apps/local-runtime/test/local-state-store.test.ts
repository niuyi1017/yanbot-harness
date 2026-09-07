import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  HARNESS_PROTOCOL_VERSION,
  type AdapterEvent,
  type LocalRun,
  type LocalSession,
} from '@yanbot-harness/contracts';

import { FileLocalStateStore, StateStoreError } from '../src/local-state-store.js';

const sessionId = '22222222-2222-4222-8222-222222222222';
const runId = '11111111-1111-4111-8111-111111111111';
const timestamp = '2026-09-07T08:00:00.000Z';
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('FileLocalStateStore', () => {
  it('persists sessions, runs, ordered events, and cursor reads with redaction', async () => {
    const root = await temporaryRoot();
    const store = new FileLocalStateStore({ stateRoot: root, secrets: ['test-secret'] });
    await store.initialize();
    await store.createSession(session());
    await store.createRun(run());

    const started = event(1, 'run.started');
    const message: AdapterEvent = {
      protocolVersion: HARNESS_PROTOCOL_VERSION,
      eventId: eventId(2),
      runId,
      sessionId,
      sequence: 2,
      timestamp,
      type: 'assistant.message',
      payload: { text: 'secret test-secret at /Users/example/private.txt' },
      adapterMetadata: { accessToken: 'test-secret' },
    };
    await Promise.all([store.appendEvent(started), store.appendEvent(message)]);

    expect(await store.listSessions()).toEqual([session()]);
    expect(await store.getRun(runId)).toEqual(run());
    expect(await store.readEvents(runId, started.eventId)).toMatchObject([
      {
        sequence: 2,
        payload: { text: 'secret [REDACTED] at [REDACTED_PATH]' },
        adapterMetadata: { accessToken: '[REDACTED]' },
      },
    ]);
    const raw = await readFile(eventsPath(root), 'utf8');
    expect(raw).not.toContain('test-secret');
    expect(raw).not.toContain('/Users/example');
  });

  it('repairs an incomplete trailing JSONL record but rejects middle corruption', async () => {
    const root = await temporaryRoot();
    const store = new FileLocalStateStore({ stateRoot: root });
    await store.initialize();
    await store.createSession(session());
    await store.createRun(run({ status: 'completed', terminalEventType: 'run.completed' }));
    await store.appendEvent(event(1, 'run.started'));
    await store.appendEvent(event(2, 'run.completed'));
    await appendFile(eventsPath(root), '{"partial":', 'utf8');

    const recovered = new FileLocalStateStore({ stateRoot: root });
    await recovered.initialize();
    expect(await recovered.readEvents(runId)).toHaveLength(2);

    await appendFile(eventsPath(root), '{"invalid":true}\n', 'utf8');
    const corrupted = new FileLocalStateStore({ stateRoot: root });
    await expect(corrupted.initialize()).rejects.toBeInstanceOf(StateStoreError);
  });

  it('closes an interrupted run with a replayable terminal event on restart', async () => {
    const root = await temporaryRoot();
    const store = new FileLocalStateStore({ stateRoot: root });
    await store.initialize();
    await store.createSession(session({ status: 'running' }));
    await store.createRun(run({ status: 'running' }));
    await store.appendEvent(event(1, 'run.started'));

    let generated = 7;
    const recovered = new FileLocalStateStore({
      stateRoot: root,
      now: () => new Date(timestamp),
      generateId: () => eventId(generated++),
    });
    await recovered.initialize();

    expect(await recovered.getRun(runId)).toMatchObject({
      status: 'interrupted',
      lastSequence: 2,
      terminalEventType: 'run.failed',
    });
    expect(await recovered.getSession(sessionId)).toMatchObject({ status: 'failed', lastRunId: runId });
    expect(await recovered.readEvents(runId)).toMatchObject([
      { sequence: 1, type: 'run.started' },
      { sequence: 2, type: 'run.failed', payload: { error: { code: 'INTERNAL_ERROR' } } },
    ]);
  });

  it('rejects duplicate event sequences and foreign cursors', async () => {
    const root = await temporaryRoot();
    const store = new FileLocalStateStore({ stateRoot: root });
    await store.initialize();
    await store.createSession(session());
    await store.createRun(run());
    await store.appendEvent(event(1, 'run.started'));

    await expect(store.appendEvent(event(1, 'run.started'))).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
    await expect(store.readEvents(runId, eventId(9))).rejects.toMatchObject({ code: 'STATE_CONFLICT' });

    await store.appendEvent(event(2, 'run.completed'));
    await expect(store.appendEvent(event(3, 'run.completed'))).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
  });
});

function session(overrides: Partial<LocalSession> = {}): LocalSession {
  return {
    protocolVersion: HARNESS_PROTOCOL_VERSION,
    sessionId,
    adapterId: 'cn.yanbot.reference',
    status: 'idle',
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

function run(overrides: Partial<LocalRun> = {}): LocalRun {
  return {
    protocolVersion: HARNESS_PROTOCOL_VERSION,
    runId,
    sessionId,
    adapterId: 'cn.yanbot.reference',
    status: 'queued',
    prompt: 'Inspect the repository',
    permissionPolicy: 'interactive',
    createdAt: timestamp,
    ...overrides,
  };
}

function event(sequence: number, type: 'run.started' | 'run.completed'): AdapterEvent {
  const base = {
    protocolVersion: HARNESS_PROTOCOL_VERSION,
    eventId: eventId(sequence),
    runId,
    sessionId,
    sequence,
    timestamp,
  };
  return type === 'run.started'
    ? { ...base, type, payload: { adapterId: 'cn.yanbot.reference' } }
    : { ...base, type, payload: {} };
}

function eventId(sequence: number): string {
  return `${sequence}3333333-3333-4333-8333-333333333333`;
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'yanbot-harness-state-'));
  roots.push(root);
  return root;
}

function eventsPath(root: string): string {
  return path.join(root, 'sessions', sessionId, 'runs', runId, 'events.jsonl');
}
