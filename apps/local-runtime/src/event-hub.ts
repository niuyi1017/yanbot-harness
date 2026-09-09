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
  lastSequence: number;
  signal?: AbortSignal;
  onAbort?: () => void;
};

export class LocalEventHub {
  readonly #store: LocalStateStore;
  readonly #maxBufferedEvents: number;
  readonly #subscribers = new Map<string, Set<Subscriber>>();

  constructor(store: LocalStateStore, options: { maxBufferedEvents?: number } = {}) {
    this.#store = store;
    this.#maxBufferedEvents = options.maxBufferedEvents ?? 256;
  }

  async publish(event: AdapterEvent, afterPersist?: (persisted: AdapterEvent) => Promise<void>): Promise<void> {
    const persisted = await this.#store.appendEvent(event);
    try {
      await afterPersist?.(persisted);
    } catch (error) {
      for (const subscriber of this.#subscribers.get(persisted.runId) ?? []) {
        subscriber.closed = true;
        this.#wake(subscriber);
      }
      throw error;
    }
    for (const subscriber of this.#subscribers.get(persisted.runId) ?? []) {
      if (subscriber.closed) continue;
      if (persisted.sequence <= subscriber.lastSequence) continue;
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

  subscribe(runId: string, afterEventId?: string, options: { signal?: AbortSignal } = {}): AsyncIterable<AdapterEvent> {
    return { [Symbol.asyncIterator]: () => this.#iterate(runId, afterEventId, options.signal) };
  }

  async *#iterate(runId: string, afterEventId?: string, signal?: AbortSignal): AsyncGenerator<AdapterEvent> {
    const subscriber: Subscriber = {
      queue: [],
      waiters: [],
      closed: signal?.aborted ?? false,
      overflowed: false,
      lastSequence: 0,
      ...(signal === undefined ? {} : { signal }),
    };
    if (signal) {
      subscriber.onAbort = () => {
        subscriber.closed = true;
        this.#wake(subscriber);
      };
      signal.addEventListener('abort', subscriber.onAbort, { once: true });
    }
    const runSubscribers = this.#subscribers.get(runId) ?? new Set<Subscriber>();
    runSubscribers.add(subscriber);
    this.#subscribers.set(runId, runSubscribers);

    try {
      const history = await this.#store.readEvents(runId, afterEventId);
      const historicalLastSequence = history.at(-1)?.sequence ?? 0;
      // The subscriber is registered before the history read so no live event
      // can be missed. Remove events already captured by that history snapshot
      // before yielding; otherwise a duplicate can consume the bounded live
      // queue while the generator is paused on its first historical event.
      subscriber.queue = subscriber.queue.filter((event) => event.sequence > historicalLastSequence);
      for (const event of history) {
        subscriber.lastSequence = event.sequence;
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
          if (event.sequence <= subscriber.lastSequence) continue;
          subscriber.lastSequence = event.sequence;
          yield event;
          if (terminalTypes.has(event.type)) return;
          continue;
        }
        if (subscriber.overflowed) throw new EventBufferOverflowError();
        if (subscriber.closed) return;
        await new Promise<void>((resolve) => subscriber.waiters.push(resolve));
      }
    } finally {
      if (subscriber.signal && subscriber.onAbort) {
        subscriber.signal.removeEventListener('abort', subscriber.onAbort);
      }
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
