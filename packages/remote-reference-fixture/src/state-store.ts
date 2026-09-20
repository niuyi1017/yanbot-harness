import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  adapterEventSchema,
  opaqueIdSchema,
  runSchema,
  sessionSchema,
  uuidSchema,
  type AdapterEvent,
  type Run,
  type Session,
} from '@yanbot-harness/contracts';

const stateFileName = 'remote-reference-state.json';
const maximumStateBytes = 16 * 1024 * 1024;

export type PersistedSnapshotRecord = {
  tenantId: string;
  uploadId: string;
  digest: string;
  workspaceRef: string;
};

export type PersistedIdempotencyRecord = {
  tenantId: string;
  sessionId: string;
  key: string;
  fingerprint: string;
  runId: string;
};

export type PersistedFixtureState = {
  sessions: Array<{ tenantId: string; session: Session }>;
  runs: Array<{ tenantId: string; run: Run; events: AdapterEvent[] }>;
  snapshots: PersistedSnapshotRecord[];
  idempotency: PersistedIdempotencyRecord[];
};

type PersistedFixtureStateV1 = PersistedFixtureState & { schemaVersion: 1 };

export class RemoteFixtureStateError extends Error {
  constructor(message = 'The Remote Reference Fixture state is invalid.', options?: ErrorOptions) {
    super(message, options);
    this.name = 'RemoteFixtureStateError';
  }
}

export class FixtureStateStore {
  readonly #root: string;
  readonly #file: string;
  #writeQueue = Promise.resolve();

  private constructor(root: string) {
    this.#root = root;
    this.#file = path.join(root, stateFileName);
  }

  static async open(root: string): Promise<{ store: FixtureStateStore; state: PersistedFixtureState }> {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const store = new FixtureStateStore(root);
    return { store, state: await store.#load() };
  }

  save(state: PersistedFixtureState): Promise<void> {
    const serialized = serializeState(state);
    this.#writeQueue = this.#writeQueue.then(() => this.#write(serialized));
    return this.#writeQueue;
  }

  flush(): Promise<void> {
    return this.#writeQueue;
  }

  async #load(): Promise<PersistedFixtureState> {
    let bytes: Buffer;
    try {
      bytes = await readFile(this.#file);
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return emptyState();
      throw new RemoteFixtureStateError(undefined, { cause: error });
    }
    if (bytes.length > maximumStateBytes) throw new RemoteFixtureStateError();
    try {
      return parseState(JSON.parse(bytes.toString('utf8')));
    } catch (error) {
      if (error instanceof RemoteFixtureStateError) throw error;
      throw new RemoteFixtureStateError(undefined, { cause: error });
    }
  }

  async #write(serialized: string): Promise<void> {
    if (Buffer.byteLength(serialized) > maximumStateBytes) {
      throw new RemoteFixtureStateError('The Remote Reference Fixture state exceeds its safety limit.');
    }
    const temporary = path.join(this.#root, `.${stateFileName}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await rename(temporary, this.#file);
      await chmod(this.#file, 0o600);
    } catch (error) {
      throw new RemoteFixtureStateError('The Remote Reference Fixture state could not be persisted.', {
        cause: error,
      });
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

export function fixtureStatePath(root: string): string {
  return path.join(root, stateFileName);
}

function serializeState(state: PersistedFixtureState): string {
  const value: PersistedFixtureStateV1 = { schemaVersion: 1, ...state };
  return `${JSON.stringify(value)}\n`;
}

function parseState(value: unknown): PersistedFixtureState {
  if (!isObject(value) || !hasExactKeys(value, ['schemaVersion', 'sessions', 'runs', 'snapshots', 'idempotency'])) {
    throw new RemoteFixtureStateError();
  }
  if (
    value.schemaVersion !== 1 ||
    !Array.isArray(value.sessions) ||
    !Array.isArray(value.runs) ||
    !Array.isArray(value.snapshots) ||
    !Array.isArray(value.idempotency)
  ) {
    throw new RemoteFixtureStateError();
  }

  const sessions = value.sessions.map((raw) => {
    if (!isObject(raw) || !hasExactKeys(raw, ['tenantId', 'session'])) throw new RemoteFixtureStateError();
    return { tenantId: identifier(raw.tenantId), session: sessionSchema.parse(raw.session) };
  });
  const sessionKeys = uniqueKeys(sessions.map((record) => resourceKey(record.tenantId, record.session.sessionId)));

  const runs = value.runs.map((raw) => {
    if (!isObject(raw) || !hasExactKeys(raw, ['tenantId', 'run', 'events'])) throw new RemoteFixtureStateError();
    const tenantId = identifier(raw.tenantId);
    const run = runSchema.parse(raw.run);
    if (!Array.isArray(raw.events)) throw new RemoteFixtureStateError();
    const events = raw.events.map((event) => adapterEventSchema.parse(event));
    validateEvents(run, events);
    if (!sessionKeys.has(resourceKey(tenantId, run.sessionId))) throw new RemoteFixtureStateError();
    return { tenantId, run, events };
  });
  const runKeys = uniqueKeys(runs.map((record) => resourceKey(record.tenantId, record.run.runId)));

  const snapshots = value.snapshots.map((raw) => {
    if (!isObject(raw) || !hasExactKeys(raw, ['tenantId', 'uploadId', 'digest', 'workspaceRef'])) {
      throw new RemoteFixtureStateError();
    }
    const record = {
      tenantId: identifier(raw.tenantId),
      uploadId: opaqueIdSchema.parse(raw.uploadId),
      digest: stringValue(raw.digest),
      workspaceRef: uuidSchema.parse(raw.workspaceRef),
    };
    if (!/^sha256:[a-f0-9]{64}$/u.test(record.digest)) throw new RemoteFixtureStateError();
    return record;
  });
  uniqueKeys(snapshots.map((record) => resourceKey(record.tenantId, record.uploadId)));

  const idempotency = value.idempotency.map((raw) => {
    if (!isObject(raw) || !hasExactKeys(raw, ['tenantId', 'sessionId', 'key', 'fingerprint', 'runId'])) {
      throw new RemoteFixtureStateError();
    }
    const record = {
      tenantId: identifier(raw.tenantId),
      sessionId: stringValue(raw.sessionId),
      key: identifier(raw.key),
      fingerprint: stringValue(raw.fingerprint),
      runId: stringValue(raw.runId),
    };
    if (
      !sessionKeys.has(resourceKey(record.tenantId, record.sessionId)) ||
      !runKeys.has(resourceKey(record.tenantId, record.runId))
    ) {
      throw new RemoteFixtureStateError();
    }
    return record;
  });
  uniqueKeys(idempotency.map((record) => resourceKey(record.tenantId, record.sessionId, record.key)));
  return { sessions, runs, snapshots, idempotency };
}

function validateEvents(run: Run, events: readonly AdapterEvent[]): void {
  const ids = new Set<string>();
  let terminalSeen = false;
  for (const [index, event] of events.entries()) {
    if (
      event.runId !== run.runId ||
      event.sessionId !== run.sessionId ||
      event.sequence !== index + 1 ||
      ids.has(event.eventId) ||
      terminalSeen
    ) {
      throw new RemoteFixtureStateError();
    }
    ids.add(event.eventId);
    terminalSeen = isTerminal(event);
  }
  if (terminalSeen !== isTerminalRun(run)) throw new RemoteFixtureStateError();
  if (terminalSeen && run.terminalEventType !== events.at(-1)?.type) throw new RemoteFixtureStateError();
  if (events.length > 0 && (run.firstSequence !== 1 || run.lastSequence !== events.length)) {
    throw new RemoteFixtureStateError();
  }
}

function isTerminal(event: AdapterEvent): boolean {
  return event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.cancelled';
}

function isTerminalRun(run: Run): boolean {
  return run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled';
}

function emptyState(): PersistedFixtureState {
  return { sessions: [], runs: [], snapshots: [], idempotency: [] };
}

function uniqueKeys(values: readonly string[]): Set<string> {
  const result = new Set<string>();
  for (const value of values) {
    if (result.has(value)) throw new RemoteFixtureStateError();
    result.add(value);
  }
  return result;
}

function identifier(value: unknown): string {
  const result = stringValue(value).trim();
  if (!result || result.length > 256) throw new RemoteFixtureStateError();
  return result;
}

function stringValue(value: unknown): string {
  if (typeof value !== 'string' || value.length > 1_000_000) throw new RemoteFixtureStateError();
  return value;
}

function resourceKey(...parts: string[]): string {
  return parts.map((part) => `${part.length}:${part}`).join('|');
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
