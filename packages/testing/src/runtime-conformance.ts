import assert from 'node:assert/strict';

import type {
  AdapterEvent,
  AdapterSummary,
  CreateRunResult,
  InteractionResponse,
  ModelDescriptor,
  Run,
  RuntimeDiscovery,
  RuntimeExecutionMode,
  Session,
} from '@yanbot-harness/contracts';

export type RuntimeConformanceRunInput = {
  prompt: string;
  resume?: boolean;
};

export type RuntimeConformanceDriver = {
  readonly adapterId: string;
  readonly expectedExecutionMode: RuntimeExecutionMode;
  health(): Promise<RuntimeDiscovery>;
  listAdapters(): Promise<AdapterSummary[]>;
  listModels(adapterId: string): Promise<ModelDescriptor[]>;
  createSession(input: { adapterId: string; title?: string }): Promise<Session>;
  listSessions(): Promise<Session[]>;
  getSession(sessionId: string): Promise<Session>;
  createRun(
    sessionId: string,
    input: RuntimeConformanceRunInput,
    options?: { idempotencyKey?: string },
  ): Promise<CreateRunResult>;
  getRun(runId: string): Promise<Run>;
  cancelRun(runId: string, reason?: string): Promise<Run>;
  respond(response: InteractionResponse): Promise<void>;
  events(runId: string, options?: { afterEventId?: string; signal?: AbortSignal }): AsyncIterable<AdapterEvent>;
};

export async function verifyRuntimeDiscoveryConformance(driver: RuntimeConformanceDriver): Promise<void> {
  const discovery = await driver.health();
  assert.equal(discovery.status, 'ok');
  assert.equal(discovery.profile.executionMode, driver.expectedExecutionMode);
  assert.ok(discovery.profile.capabilities.workspaceSources.length > 0);

  const adapters = await driver.listAdapters();
  assert.ok(adapters.some((adapter) => adapter.manifest.adapterId === driver.adapterId));
  const models = await driver.listModels(driver.adapterId);
  assert.ok(models.some((model) => model.ref.adapterId === driver.adapterId));

  const session = await driver.createSession({ adapterId: driver.adapterId, title: 'Conformance session' });
  assert.equal(session.adapterId, driver.adapterId);
  assert.equal(session.title, 'Conformance session');
  assert.deepEqual(await driver.getSession(session.sessionId), session);
  assert.ok((await driver.listSessions()).some((candidate) => candidate.sessionId === session.sessionId));
}

export async function verifyRuntimeRunConformance(driver: RuntimeConformanceDriver): Promise<void> {
  const session = await driver.createSession({ adapterId: driver.adapterId });
  const input = { prompt: 'Conformance run and idempotency.' };
  const idempotencyKey = `conformance-${session.sessionId}`;
  const first = await driver.createRun(session.sessionId, input, { idempotencyKey });
  const duplicate = await driver.createRun(session.sessionId, input, { idempotencyKey });
  assert.equal(first.reused, false);
  assert.equal(duplicate.reused, true);
  assert.equal(duplicate.run.runId, first.run.runId);

  const events = await collectConformanceEvents(driver.events(first.run.runId));
  assert.ok(events.length > 0);
  assertMonotonicEvents(events, first.run.runId, session.sessionId);
  const terminal = events.filter(isTerminal);
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0]?.type, 'run.completed');
  assert.equal(events.at(-1)?.eventId, terminal[0]?.eventId);
  const finalRun = await driver.getRun(first.run.runId);
  assert.equal(finalRun.runId, first.run.runId);
  assert.equal(finalRun.status, 'completed');
}

export async function verifyRuntimeInteractionConformance(driver: RuntimeConformanceDriver): Promise<void> {
  const session = await driver.createSession({ adapterId: driver.adapterId });
  const created = await driver.createRun(session.sessionId, { prompt: 'Conformance interaction and replay.' });
  const iterator = driver.events(created.run.runId)[Symbol.asyncIterator]();
  let requested: Extract<AdapterEvent, { type: 'interaction.requested' }> | undefined;
  while (!requested) {
    const item = await iterator.next();
    assert.equal(item.done, false, 'The run ended before requesting an interaction.');
    if (item.value?.type === 'interaction.requested') requested = item.value;
  }
  await iterator.return?.();
  assert.equal((await driver.getRun(created.run.runId)).status, 'running');
  assert.equal(requested.payload.kind, 'question');
  if (requested.payload.kind !== 'question') throw new Error('Expected a question interaction.');
  const question = requested.payload.questions[0];
  assert.ok(question);
  await driver.respond({
    requestId: requested.payload.requestId,
    action: 'submit',
    answers: { [question.id]: 'yes' },
  });

  const replay = await collectConformanceEvents(driver.events(created.run.runId, { afterEventId: requested.eventId }));
  assert.ok(replay.length > 0);
  assert.ok(replay.every((event) => event.eventId !== requested?.eventId));
  assert.deepEqual(
    replay.map((event) => event.type),
    ['interaction.resolved', 'assistant.message', 'run.completed'],
  );
  assert.equal((await driver.getRun(created.run.runId)).status, 'completed');
}

export async function verifyRuntimeCancellationConformance(driver: RuntimeConformanceDriver): Promise<void> {
  const session = await driver.createSession({ adapterId: driver.adapterId });
  const created = await driver.createRun(session.sessionId, { prompt: 'Conformance cancellation.' });
  await driver.cancelRun(created.run.runId, 'Conformance cancellation.');
  const events = await collectConformanceEvents(driver.events(created.run.runId));
  assertMonotonicEvents(events, created.run.runId, session.sessionId);
  const terminal = events.filter(isTerminal);
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0]?.type, 'run.cancelled');
  if (terminal[0]?.type !== 'run.cancelled') throw new Error('Expected a cancelled terminal event.');
  assert.equal(terminal[0].payload.reason, 'Conformance cancellation.');
  assert.equal(events.at(-1)?.eventId, terminal[0].eventId);
  assert.equal((await driver.getRun(created.run.runId)).status, 'cancelled');
}

async function collectConformanceEvents(source: AsyncIterable<AdapterEvent>, limit = 1_000): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  for await (const event of source) {
    events.push(event);
    if (events.length > limit) throw new Error(`Runtime Conformance exceeded the ${limit} event safety limit.`);
  }
  return events;
}

function assertMonotonicEvents(events: readonly AdapterEvent[], runId: string, sessionId: string): void {
  for (const [index, event] of events.entries()) {
    assert.equal(event.runId, runId);
    assert.equal(event.sessionId, sessionId);
    if (index > 0) assert.equal(event.sequence, events[index - 1]!.sequence + 1);
  }
}

function isTerminal(event: AdapterEvent): boolean {
  return event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.cancelled';
}
