import type { AdapterEvent } from '@yanbot-harness/contracts';

import type { LocalStateStore } from './local-state-store.js';

const terminalTypes = new Set<AdapterEvent['type']>(['run.completed', 'run.failed', 'run.cancelled']);

export class EventBufferOverflowError extends Error {
  constructor() {
    super('The local event subscriber fell behind and must reconnect from its last cursor.');
    this.name = 'EventBufferOverflowError';
  }
}

type Subscriber = {
  queue: AdapterEvent[];
  waiters: Array<() => void>;
  closed: boolean;
  overflowed: boolean;
};

export class LocalEventHub {
  readonly #store: LocalStateStore;
  readonly #maxBufferedEvents: number;
  readonly #subscribers = new Map<string, Set<Subscriber>>();

  constructor(store: LocalStateStore, options: { maxBufferedEvents?: number } = {}) {
    this.#store = store;
    this.#maxBufferedEvents = options.maxBufferedEvents ?? 256;
  }

  async publish(event: AdapterEvent): Promise<void> {
    const persisted = await this.#store.appendEvent(event);
    for (const subscriber of this.#subscribers.get(persisted.runId) ?? []) {
      if (subscriber.closed) continue;
      if (subscriber.queue.length >= this.#maxBufferedEvents) {
        subscriber.overflowed = true;
        subscriber.closed = true;
      } else {
        subscriber.queue.push(persisted);
        if (terminalTypes.has(persisted.type)) subscriber.closed = true;
      }
      this.#wake(subscriber);
    }
  }

  subscribe(runId: string, afterEventId?: string): AsyncIterable<AdapterEvent> {
    return { [Symbol.asyncIterator]: () => this.#iterate(runId, afterEventId) };
  }

  async *#iterate(runId: string, afterEventId?: string): AsyncGenerator<AdapterEvent> {
    const subscriber: Subscriber = { queue: [], waiters: [], closed: false, overflowed: false };
    const runSubscribers = this.#subscribers.get(runId) ?? new Set<Subscriber>();
    runSubscribers.add(subscriber);
    this.#subscribers.set(runId, runSubscribers);

    try {
      const history = await this.#store.readEvents(runId, afterEventId);
      let lastSequence = 0;
      for (const event of history) {
        lastSequence = event.sequence;
        yield event;
      }
      if (history.some((event) => terminalTypes.has(event.type))) return;
      if (afterEventId !== undefined && history.length === 0) {
        const lastPersisted = (await this.#store.readEvents(runId)).at(-1);
        if (lastPersisted && terminalTypes.has(lastPersisted.type)) return;
      }
      const run = await this.#store.getRun(runId);
      if (run?.terminalEventType) return;

      while (true) {
        const event = subscriber.queue.shift();
        if (event) {
          if (event.sequence <= lastSequence) continue;
          lastSequence = event.sequence;
          yield event;
          if (terminalTypes.has(event.type)) return;
          continue;
        }
        if (subscriber.overflowed) throw new EventBufferOverflowError();
        if (subscriber.closed) return;
        await new Promise<void>((resolve) => subscriber.waiters.push(resolve));
      }
    } finally {
      subscriber.closed = true;
      this.#wake(subscriber);
      runSubscribers.delete(subscriber);
      if (runSubscribers.size === 0) this.#subscribers.delete(runId);
    }
  }

  #wake(subscriber: Subscriber): void {
    for (const resolve of subscriber.waiters.splice(0)) resolve();
  }
}
