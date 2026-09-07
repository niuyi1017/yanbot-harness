import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, truncate, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  HARNESS_PROTOCOL_VERSION,
  adapterEventSchema,
  localRunSchema,
  localSessionSchema,
  type AdapterEvent,
  type LocalRun,
  type LocalSession,
} from '@yanbot-harness/contracts';

import { redactEventForPersistence, type RedactionOptions } from './redaction.js';

const STORE_SCHEMA_VERSION = 1;
const MAX_EVENT_LINE_BYTES = 1_048_576;

type Stored<T> = { schemaVersion: number; data: T };
type RunLocation = { sessionId: string; directory: string };

export interface LocalStateStore {
  initialize(): Promise<void>;
  createSession(session: LocalSession): Promise<void>;
  updateSession(session: LocalSession): Promise<void>;
  getSession(sessionId: string): Promise<LocalSession | undefined>;
  listSessions(): Promise<LocalSession[]>;
  createRun(run: LocalRun): Promise<void>;
  updateRun(run: LocalRun): Promise<void>;
  getRun(runId: string): Promise<LocalRun | undefined>;
  appendEvent(event: AdapterEvent): Promise<AdapterEvent>;
  readEvents(runId: string, afterEventId?: string): Promise<AdapterEvent[]>;
}

export type FileLocalStateStoreOptions = RedactionOptions & {
  stateRoot: string;
  now?: () => Date;
  generateId?: () => string;
};

export class StateStoreError extends Error {
  readonly code: 'STATE_CONFLICT' | 'STATE_CORRUPT' | 'STATE_NOT_FOUND';

  constructor(code: StateStoreError['code'], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'StateStoreError';
    this.code = code;
  }
}

export class FileLocalStateStore implements LocalStateStore {
  readonly #stateRoot: string;
  readonly #redaction: RedactionOptions;
  readonly #now: () => Date;
  readonly #generateId: () => string;
  readonly #sessions = new Map<string, LocalSession>();
  readonly #runs = new Map<string, LocalRun>();
  readonly #runLocations = new Map<string, RunLocation>();
  readonly #appendQueues = new Map<string, Promise<void>>();
  #initialized = false;

  constructor(options: FileLocalStateStoreOptions) {
    this.#stateRoot = path.resolve(options.stateRoot);
    this.#redaction = {
      ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
      ...(options.workspaceRoots === undefined ? {} : { workspaceRoots: options.workspaceRoots }),
    };
    this.#now = options.now ?? (() => new Date());
    this.#generateId = options.generateId ?? randomUUID;
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    await mkdir(this.#sessionsRoot(), { recursive: true, mode: 0o700 });
    await this.#ensureStoreMetadata();
    await this.#loadExistingState();
    this.#initialized = true;
    await this.#recoverInterruptedRuns();
  }

  async createSession(session: LocalSession): Promise<void> {
    this.#assertInitialized();
    const parsed = localSessionSchema.parse(session);
    if (this.#sessions.has(parsed.sessionId)) throw conflict(`Session ${parsed.sessionId} already exists.`);
    const directory = this.#sessionDirectory(parsed.sessionId);
    await mkdir(path.join(directory, 'runs'), { recursive: true, mode: 0o700 });
    await this.#writeStored(path.join(directory, 'session.json'), parsed);
    this.#sessions.set(parsed.sessionId, parsed);
  }

  async updateSession(session: LocalSession): Promise<void> {
    this.#assertInitialized();
    const parsed = localSessionSchema.parse(session);
    if (!this.#sessions.has(parsed.sessionId)) throw notFound(`Session ${parsed.sessionId} does not exist.`);
    await this.#writeStored(path.join(this.#sessionDirectory(parsed.sessionId), 'session.json'), parsed);
    this.#sessions.set(parsed.sessionId, parsed);
  }

  async getSession(sessionId: string): Promise<LocalSession | undefined> {
    this.#assertInitialized();
    return this.#sessions.get(sessionId);
  }

  async listSessions(): Promise<LocalSession[]> {
    this.#assertInitialized();
    return [...this.#sessions.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async createRun(run: LocalRun): Promise<void> {
    this.#assertInitialized();
    const parsed = localRunSchema.parse(run);
    if (!this.#sessions.has(parsed.sessionId)) throw notFound(`Session ${parsed.sessionId} does not exist.`);
    if (this.#runs.has(parsed.runId)) throw conflict(`Run ${parsed.runId} already exists.`);
    const directory = this.#runDirectory(parsed.sessionId, parsed.runId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await this.#writeStored(path.join(directory, 'run.json'), parsed);
    await writeFile(path.join(directory, 'events.jsonl'), '', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    this.#runs.set(parsed.runId, parsed);
    this.#runLocations.set(parsed.runId, { sessionId: parsed.sessionId, directory });
  }

  async updateRun(run: LocalRun): Promise<void> {
    this.#assertInitialized();
    const parsed = localRunSchema.parse(run);
    const location = this.#runLocations.get(parsed.runId);
    if (!location || location.sessionId !== parsed.sessionId) throw notFound(`Run ${parsed.runId} does not exist.`);
    await this.#writeStored(path.join(location.directory, 'run.json'), parsed);
    this.#runs.set(parsed.runId, parsed);
  }

  async getRun(runId: string): Promise<LocalRun | undefined> {
    this.#assertInitialized();
    return this.#runs.get(runId);
  }

  async appendEvent(event: AdapterEvent): Promise<AdapterEvent> {
    this.#assertInitialized();
    const parsed = redactEventForPersistence(adapterEventSchema.parse(event), this.#redaction);
    const location = this.#runLocations.get(parsed.runId);
    if (!location || location.sessionId !== parsed.sessionId) throw notFound(`Run ${parsed.runId} does not exist.`);

    const previous = this.#appendQueues.get(parsed.runId) ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(async () => {
        const existing = await this.#readEventFile(location.directory, false);
        const last = existing.at(-1);
        if (last && isTerminalEvent(last)) throw conflict(`Run ${parsed.runId} already has a terminal event.`);
        const expected = (last?.sequence ?? 0) + 1;
        if (parsed.sequence !== expected) {
          throw conflict(`Run ${parsed.runId} expected event sequence ${expected}, received ${parsed.sequence}.`);
        }
        const line = `${JSON.stringify(parsed)}\n`;
        if (Buffer.byteLength(line) > MAX_EVENT_LINE_BYTES) throw conflict('The event exceeds the local size limit.');
        const handle = await open(path.join(location.directory, 'events.jsonl'), 'a', 0o600);
        try {
          await handle.writeFile(line, 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }
      });
    this.#appendQueues.set(parsed.runId, operation);
    try {
      await operation;
    } finally {
      if (this.#appendQueues.get(parsed.runId) === operation) this.#appendQueues.delete(parsed.runId);
    }
    return parsed;
  }

  async readEvents(runId: string, afterEventId?: string): Promise<AdapterEvent[]> {
    this.#assertInitialized();
    const location = this.#runLocations.get(runId);
    if (!location) throw notFound(`Run ${runId} does not exist.`);
    await this.#appendQueues.get(runId);
    const events = await this.#readEventFile(location.directory, true);
    if (afterEventId === undefined) return events;
    const index = events.findIndex((event) => event.eventId === afterEventId);
    if (index < 0) throw conflict(`Event cursor ${afterEventId} does not belong to run ${runId}.`);
    return events.slice(index + 1);
  }

  async #ensureStoreMetadata(): Promise<void> {
    const file = path.join(this.#stateRoot, 'store.json');
    try {
      const stored = JSON.parse(await readFile(file, 'utf8')) as { schemaVersion?: unknown };
      if (stored.schemaVersion !== STORE_SCHEMA_VERSION) throw corrupt('Unsupported local state schema version.');
    } catch (error) {
      if (isMissing(error)) {
        await this.#writeJsonAtomic(file, { schemaVersion: STORE_SCHEMA_VERSION });
        return;
      }
      if (error instanceof StateStoreError) throw error;
      throw corrupt('Local state metadata is invalid.', error);
    }
  }

  async #loadExistingState(): Promise<void> {
    const sessionEntries = await readdir(this.#sessionsRoot(), { withFileTypes: true });
    for (const sessionEntry of sessionEntries) {
      if (!sessionEntry.isDirectory()) continue;
      const sessionDirectory = path.join(this.#sessionsRoot(), sessionEntry.name);
      const session = await this.#readStored(path.join(sessionDirectory, 'session.json'), localSessionSchema.parse);
      if (session.sessionId !== sessionEntry.name) throw corrupt('Session directory does not match its metadata.');
      this.#sessions.set(session.sessionId, session);

      const runsDirectory = path.join(sessionDirectory, 'runs');
      let runEntries;
      try {
        runEntries = await readdir(runsDirectory, { withFileTypes: true });
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }
      for (const runEntry of runEntries) {
        if (!runEntry.isDirectory()) continue;
        const directory = path.join(runsDirectory, runEntry.name);
        const run = await this.#readStored(path.join(directory, 'run.json'), localRunSchema.parse);
        if (run.runId !== runEntry.name || run.sessionId !== session.sessionId) {
          throw corrupt('Run directory does not match its metadata.');
        }
        await this.#readEventFile(directory, true);
        this.#runs.set(run.runId, run);
        this.#runLocations.set(run.runId, { sessionId: run.sessionId, directory });
      }
    }
  }

  async #recoverInterruptedRuns(): Promise<void> {
    for (const run of [...this.#runs.values()]) {
      if (run.status !== 'queued' && run.status !== 'running') continue;
      const events = await this.readEvents(run.runId);
      const persistedTerminal = events.at(-1);
      if (persistedTerminal && isTerminalEvent(persistedTerminal)) {
        const adapterSessionId = events.findLast(
          (event): event is Extract<AdapterEvent, { type: 'session.initialized' }> =>
            event.type === 'session.initialized' && event.payload.adapterSessionId !== undefined,
        )?.payload.adapterSessionId;
        await this.updateRun({
          ...run,
          ...(adapterSessionId === undefined ? {} : { adapterSessionId }),
          status: runStatusFromTerminal(persistedTerminal),
          firstSequence: run.firstSequence ?? events[0]?.sequence,
          lastSequence: persistedTerminal.sequence,
          terminalEventType: persistedTerminal.type,
          completedAt: persistedTerminal.timestamp,
        });
        const session = this.#sessions.get(run.sessionId);
        if (session) {
          await this.updateSession({
            ...session,
            ...(adapterSessionId === undefined ? {} : { adapterSessionId }),
            status: persistedTerminal.type === 'run.failed' ? 'failed' : 'idle',
            lastRunId: run.runId,
            updatedAt: this.#now().toISOString(),
          });
        }
        continue;
      }
      let sequence = events.at(-1)?.sequence ?? 0;
      if (sequence === 0) {
        sequence = 1;
        await this.appendEvent({
          protocolVersion: HARNESS_PROTOCOL_VERSION,
          eventId: this.#generateId(),
          runId: run.runId,
          sessionId: run.sessionId,
          sequence,
          timestamp: this.#now().toISOString(),
          type: 'run.started',
          payload: { adapterId: run.adapterId, ...(run.model === undefined ? {} : { model: run.model }) },
          adapterMetadata: { source: 'local-runtime-recovery' },
        });
      }
      await this.appendEvent({
        protocolVersion: HARNESS_PROTOCOL_VERSION,
        eventId: this.#generateId(),
        runId: run.runId,
        sessionId: run.sessionId,
        sequence: sequence + 1,
        timestamp: this.#now().toISOString(),
        type: 'run.failed',
        payload: {
          error: {
            code: 'INTERNAL_ERROR',
            message: 'The local runtime stopped before this run reached a terminal state.',
            retryable: true,
          },
        },
        adapterMetadata: { source: 'local-runtime-recovery' },
      });
      await this.updateRun({
        ...run,
        status: 'interrupted',
        firstSequence: run.firstSequence ?? 1,
        lastSequence: sequence + 1,
        terminalEventType: 'run.failed',
        completedAt: this.#now().toISOString(),
      });
      const session = this.#sessions.get(run.sessionId);
      if (session) {
        await this.updateSession({
          ...session,
          status: 'failed',
          lastRunId: run.runId,
          updatedAt: this.#now().toISOString(),
        });
      }
    }
  }

  async #readEventFile(directory: string, repairTail: boolean): Promise<AdapterEvent[]> {
    const file = path.join(directory, 'events.jsonl');
    let content: string;
    try {
      content = await readFile(file, 'utf8');
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    if (!content) return [];

    if (!content.endsWith('\n') && repairTail) {
      const boundary = content.lastIndexOf('\n');
      const safeLength = boundary < 0 ? 0 : Buffer.byteLength(content.slice(0, boundary + 1));
      await truncate(file, safeLength);
      content = boundary < 0 ? '' : content.slice(0, boundary + 1);
    }
    const lines = content.split('\n');
    if (lines.at(-1) === '') lines.pop();
    if (lines.some((line) => line.length === 0)) throw corrupt('A local event log contains an empty record.');
    const events: AdapterEvent[] = [];
    for (const line of lines) {
      if (Buffer.byteLength(line) > MAX_EVENT_LINE_BYTES) throw corrupt('A local event line exceeds the size limit.');
      try {
        const event = adapterEventSchema.parse(JSON.parse(line));
        const expected = events.length + 1;
        if (event.sequence !== expected) throw corrupt('Local event sequence is not contiguous.');
        const expectedRunId = path.basename(directory);
        const expectedSessionId = path.basename(path.dirname(path.dirname(directory)));
        if (event.runId !== expectedRunId || event.sessionId !== expectedSessionId) {
          throw corrupt('A local event references a different run or session.');
        }
        if (expected === 1 && event.type !== 'run.started')
          throw corrupt('A local event log must start with run.started.');
        if (events.some(isTerminalEvent)) throw corrupt('A local event appears after the terminal event.');
        events.push(event);
      } catch (error) {
        if (error instanceof StateStoreError) throw error;
        throw corrupt('A local event log contains an invalid record.', error);
      }
    }
    return events;
  }

  async #readStored<T>(file: string, parse: (value: unknown) => T): Promise<T> {
    try {
      const stored = JSON.parse(await readFile(file, 'utf8')) as Stored<unknown>;
      if (stored.schemaVersion !== STORE_SCHEMA_VERSION) throw corrupt('Unsupported stored object schema version.');
      return parse(stored.data);
    } catch (error) {
      if (error instanceof StateStoreError) throw error;
      throw corrupt('A local state object is invalid.', error);
    }
  }

  async #writeStored<T>(file: string, data: T): Promise<void> {
    await this.#writeJsonAtomic(file, { schemaVersion: STORE_SCHEMA_VERSION, data });
  }

  async #writeJsonAtomic(file: string, value: unknown): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${this.#generateId()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  }

  #assertInitialized(): void {
    if (!this.#initialized) throw new StateStoreError('STATE_CONFLICT', 'Local state store is not initialized.');
  }

  #sessionsRoot(): string {
    return path.join(this.#stateRoot, 'sessions');
  }

  #sessionDirectory(sessionId: string): string {
    return path.join(this.#sessionsRoot(), sessionId);
  }

  #runDirectory(sessionId: string, runId: string): string {
    return path.join(this.#sessionDirectory(sessionId), 'runs', runId);
  }
}

function conflict(message: string): StateStoreError {
  return new StateStoreError('STATE_CONFLICT', message);
}

function corrupt(message: string, cause?: unknown): StateStoreError {
  return new StateStoreError('STATE_CORRUPT', message, cause === undefined ? undefined : { cause });
}

function notFound(message: string): StateStoreError {
  return new StateStoreError('STATE_NOT_FOUND', message);
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function isTerminalEvent(
  event: AdapterEvent,
): event is Extract<AdapterEvent, { type: 'run.completed' | 'run.failed' | 'run.cancelled' }> {
  return event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.cancelled';
}

function runStatusFromTerminal(event: AdapterEvent): LocalRun['status'] {
  if (event.type === 'run.completed') return 'completed';
  if (event.type === 'run.cancelled') return 'cancelled';
  return 'failed';
}
