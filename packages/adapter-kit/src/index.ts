import { randomUUID } from 'node:crypto';

import {
  HARNESS_PROTOCOL_VERSION,
  adapterEventSchema,
  type AdapterEvent,
  type HarnessCapabilities,
  type RunRequest,
} from '@yanbot-harness/contracts';
import {
  assertRuntimeMatchesCapabilities,
  type AdapterRuntime,
  type AdapterRuntimeContext,
  type HarnessAdapter,
} from '@yanbot-harness/adapter-api';

export type EventFactoryOptions = {
  runId: string;
  sessionId: string;
  now?: () => Date;
  generateId?: () => string;
};

export class AdapterEventFactory {
  readonly #runId: string;
  readonly #sessionId: string;
  readonly #now: () => Date;
  readonly #generateId: () => string;
  #sequence = 0;

  constructor(options: EventFactoryOptions) {
    this.#runId = options.runId;
    this.#sessionId = options.sessionId;
    this.#now = options.now ?? (() => new Date());
    this.#generateId = options.generateId ?? randomUUID;
  }

  create(type: AdapterEvent['type'], payload: unknown, adapterMetadata?: unknown): AdapterEvent {
    return adapterEventSchema.parse({
      protocolVersion: HARNESS_PROTOCOL_VERSION,
      eventId: this.#generateId(),
      runId: this.#runId,
      sessionId: this.#sessionId,
      sequence: ++this.#sequence,
      timestamp: this.#now().toISOString(),
      type,
      payload,
      ...(adapterMetadata === undefined ? {} : { adapterMetadata }),
    });
  }
}

export type ConformanceOptions = {
  adapter: HarnessAdapter;
  request: RunRequest;
  context?: AdapterRuntimeContext;
  forbiddenValues?: readonly string[];
  cancelAfterEvents?: number;
};

export type ConformanceReport = {
  capabilities: HarnessCapabilities;
  events: readonly AdapterEvent[];
};

const terminalTypes = new Set<AdapterEvent['type']>(['run.completed', 'run.failed', 'run.cancelled']);

export async function runAdapterConformance(options: ConformanceOptions): Promise<ConformanceReport> {
  const probe = await options.adapter.probe(options.context ?? {});
  if (!probe.available) throw new Error(`Adapter ${options.adapter.manifest.adapterId} is unavailable.`);

  const runtime = await options.adapter.createRuntime(options.context ?? {});
  try {
    const capabilities = await assertRuntimeMatchesCapabilities(runtime);
    const events = await collectAndValidate(runtime, options, terminalTypes);
    assertNoForbiddenValues(events, options.forbiddenValues ?? []);
    await runtime.dispose();
    await runtime.dispose();
    return { capabilities, events };
  } finally {
    await runtime.dispose();
  }
}

async function collectAndValidate(
  runtime: AdapterRuntime,
  options: ConformanceOptions,
  terminals: ReadonlySet<AdapterEvent['type']>,
): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  let expectedSequence = 1;
  let terminalSeen = false;
  const source = options.request.adapterSessionId
    ? runtime.resumeRun?.({ ...options.request, adapterSessionId: options.request.adapterSessionId })
    : runtime.startRun(options.request);
  if (!source) throw new Error('Adapter declared no resume implementation for a resume request.');

  for await (const candidate of source) {
    const event = adapterEventSchema.parse(candidate);
    if (event.runId !== options.request.runId || event.sessionId !== options.request.sessionId) {
      throw new Error('Adapter emitted an event for the wrong run or session.');
    }
    if (event.sequence !== expectedSequence) {
      throw new Error(`Expected sequence ${expectedSequence}, received ${event.sequence}.`);
    }
    if (expectedSequence === 1 && event.type !== 'run.started') throw new Error('The first event must be run.started.');
    if (terminalSeen) throw new Error('Adapter emitted an event after its terminal event.');

    events.push(event);
    expectedSequence += 1;
    terminalSeen = terminals.has(event.type);
    if (options.cancelAfterEvents === events.length) {
      await runtime.cancel({ runId: options.request.runId, reason: 'Conformance cancellation.' });
    }
    if (events.length > 1_000) throw new Error('Adapter exceeded the conformance event safety limit.');
  }

  if (!terminalSeen) throw new Error('Adapter stream ended without a terminal event.');
  if (events.filter((event) => terminals.has(event.type)).length !== 1) {
    throw new Error('Adapter must emit exactly one terminal event.');
  }
  return events;
}

function assertNoForbiddenValues(events: readonly AdapterEvent[], forbiddenValues: readonly string[]): void {
  const serialized = JSON.stringify(events);
  for (const value of forbiddenValues) {
    if (value && serialized.includes(value)) throw new Error('Adapter events contained a forbidden sensitive value.');
  }
}
