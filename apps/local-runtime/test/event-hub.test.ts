import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  HARNESS_PROTOCOL_VERSION,
  type AdapterEvent,
  type LocalRun,
  type LocalSession,
} from '@yanbot-harness/contracts';

import { EventBufferOverflowError, LocalEventHub } from '../src/event-hub.js';
import { FileLocalStateStore } from '../src/local-state-store.js';

const sessionId = '22222222-2222-4222-8222-222222222222';
const runId = '11111111-1111-4111-8111-111111111111';
const timestamp = '2026-09-07T08:00:00.000Z';
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('LocalEventHub', () => {
  it('replays a cursor and then closes after the persisted terminal event', async () => {
    const { store, hub } = await setup();
    const started = event(1, 'run.started');
    const completed = event(2, 'run.completed');
    await hub.publish(started);
    await hub.publish(completed);

    const received: AdapterEvent[] = [];
    for await (const candidate of hub.subscribe(runId, started.eventId)) received.push(candidate);

    expect(received).toEqual([completed]);
    expect(await store.readEvents(runId)).toEqual([started, completed]);

    const afterTerminal = hub.subscribe(runId, completed.eventId)[Symbol.asyncIterator]();
    await expect(afterTerminal.next()).resolves.toMatchObject({ done: true });
  });

  it('bridges history and live events without duplicates', async () => {
    const { hub } = await setup();
    const started = event(1, 'run.started');
    await hub.publish(started);
    const iterator = hub.subscribe(runId)[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({ value: started });
    const completed = event(2, 'run.completed');
    await hub.publish(completed);
    await expect(iterator.next()).resolves.toMatchObject({ value: completed });
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
  });

  it('requires a lagging subscriber to reconnect instead of dropping persisted events', async () => {
    const { store, hub } = await setup(1);
    const iterator = hub.subscribe(runId)[Symbol.asyncIterator]();
    const first = iterator.next();
    await hub.publish(event(1, 'run.started'));
    await expect(first).resolves.toMatchObject({ value: { sequence: 1 } });
    await hub.publish(delta(2));
    await hub.publish(delta(3));

    await expect(iterator.next()).resolves.toMatchObject({ value: { sequence: 2 } });
    await expect(iterator.next()).rejects.toBeInstanceOf(EventBufferOverflowError);
    expect(await store.readEvents(runId)).toHaveLength(3);
  });
});

async function setup(maxBufferedEvents?: number): Promise<{ store: FileLocalStateStore; hub: LocalEventHub }> {
  const root = await mkdtemp(path.join(tmpdir(), 'yanbot-harness-events-'));
  roots.push(root);
  const store = new FileLocalStateStore({ stateRoot: root });
  await store.initialize();
  await store.createSession(session());
  await store.createRun(run());
  return {
    store,
    hub: new LocalEventHub(store, maxBufferedEvents === undefined ? {} : { maxBufferedEvents }),
  };
}

function session(): LocalSession {
  return {
    protocolVersion: HARNESS_PROTOCOL_VERSION,
    sessionId,
    adapterId: 'cn.yanbot.reference',
    status: 'idle',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function run(): LocalRun {
  return {
    protocolVersion: HARNESS_PROTOCOL_VERSION,
    runId,
    sessionId,
    adapterId: 'cn.yanbot.reference',
    status: 'queued',
    prompt: 'Inspect the repository',
    permissionPolicy: 'interactive',
    createdAt: timestamp,
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

function delta(sequence: number): AdapterEvent {
  return {
    protocolVersion: HARNESS_PROTOCOL_VERSION,
    eventId: eventId(sequence),
    runId,
    sessionId,
    sequence,
    timestamp,
    type: 'assistant.delta',
    payload: { channel: 'output', text: `chunk-${sequence}` },
  };
}

function eventId(sequence: number): string {
  return `${sequence}3333333-3333-4333-8333-333333333333`;
}
