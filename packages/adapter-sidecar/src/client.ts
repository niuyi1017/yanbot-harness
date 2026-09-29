import type { ChildProcess } from 'node:child_process';
import { TextDecoder } from 'node:util';

import type { z } from 'zod';

import {
  SIDECAR_PROTOCOL_VERSION,
  initializeResultSchema,
  sidecarNotificationSchema,
  sidecarRequestSchema,
  sidecarResponseSchema,
  type SidecarNotification,
} from './index.js';

export type SidecarClientLimits = {
  maxLineBytes?: number;
  maxStderrBytes?: number;
  maxPendingRequests?: number;
  requestTimeoutMs?: number;
};

export type SidecarClientOptions = SidecarClientLimits & {
  onEvent?: (event: Extract<SidecarNotification, { method: 'event' }>['params']) => void;
  onFatal?: (error: SidecarError) => void;
};

export class SidecarError extends Error {
  constructor(
    readonly code:
      | 'PROTOCOL_ERROR'
      | 'PROCESS_EXIT'
      | 'REQUEST_TIMEOUT'
      | 'RESOURCE_LIMIT'
      | 'REMOTE_ERROR'
      | 'CLEANUP_UNVERIFIED'
      | 'DISPOSED',
    message: string,
  ) {
    super(message);
    this.name = 'SidecarError';
  }
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: SidecarError) => void;
  schema: z.ZodType<unknown>;
  timer: NodeJS.Timeout;
};

const DEFAULT_LINE_LIMIT = 4 * 1024 * 1024;
const DEFAULT_STDERR_LIMIT = 64 * 1024;
const DEFAULT_PENDING_LIMIT = 32;
const DEFAULT_REQUEST_TIMEOUT = 30_000;

/** A protocol client for one already-owned child. It never spawns or kills processes. */
export class SidecarClient {
  readonly #child: ChildProcess;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #onEvent: SidecarClientOptions['onEvent'];
  readonly #onFatal: SidecarClientOptions['onFatal'];
  readonly #lineLimit: number;
  readonly #stderrLimit: number;
  readonly #pendingLimit: number;
  readonly #requestTimeout: number;
  #stdoutParts: Buffer[] = [];
  #stdoutBytes = 0;
  #stderrBytes = 0;
  #nextId = 1;
  #failure: SidecarError | undefined;
  #disposed = false;
  #closed: Promise<void>;

  constructor(child: ChildProcess, options: SidecarClientOptions = {}) {
    if (!child.stdin || !child.stdout || !child.stderr) {
      throw new SidecarError('PROTOCOL_ERROR', 'Sidecar requires three separate pipes.');
    }
    this.#child = child;
    this.#onEvent = options.onEvent;
    this.#onFatal = options.onFatal;
    this.#lineLimit = bounded(options.maxLineBytes, DEFAULT_LINE_LIMIT, 1_024, 16 * 1024 * 1024);
    this.#stderrLimit = bounded(options.maxStderrBytes, DEFAULT_STDERR_LIMIT, 1_024, 1024 * 1024);
    this.#pendingLimit = bounded(options.maxPendingRequests, DEFAULT_PENDING_LIMIT, 1, 1_024);
    this.#requestTimeout = bounded(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT, 10, 120_000);
    this.#closed = new Promise<void>((resolve) => {
      child.once('close', () => {
        this.#fatal(new SidecarError('PROCESS_EXIT', 'Sidecar process exited.'));
        resolve();
      });
    });
    child.on('error', () => this.#fatal(new SidecarError('PROCESS_EXIT', 'Sidecar process failed.')));
    child.stdin.on('error', () => this.#fatal(new SidecarError('PROCESS_EXIT', 'Sidecar input pipe failed.')));
    child.stdout.on('error', () => this.#fatal(new SidecarError('PROCESS_EXIT', 'Sidecar output pipe failed.')));
    child.stderr.on('error', () => this.#fatal(new SidecarError('PROCESS_EXIT', 'Sidecar diagnostic pipe failed.')));
    child.stdout.on('data', (chunk: Buffer) => this.#readStdout(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      this.#stderrBytes += chunk.length;
      if (this.#stderrBytes > this.#stderrLimit) {
        this.#fatal(new SidecarError('RESOURCE_LIMIT', 'Sidecar diagnostic output exceeded its limit.'));
      }
    });
  }

  get failed(): SidecarError | undefined {
    return this.#failure;
  }

  async initialize(clientName: string, clientVersion: string, expectedAdapterId?: string) {
    const result = await this.request(
      'initialize',
      { protocolVersion: SIDECAR_PROTOCOL_VERSION, clientName, clientVersion },
      initializeResultSchema,
    );
    if (this.#failure) throw this.#failure;
    if (
      result.protocolVersion !== SIDECAR_PROTOCOL_VERSION ||
      result.manifest.protocolVersion !== SIDECAR_PROTOCOL_VERSION ||
      !result.manifest.runtimeKinds.includes('sidecar') ||
      (expectedAdapterId !== undefined && result.manifest.adapterId !== expectedAdapterId)
    ) {
      const error = new SidecarError('PROTOCOL_ERROR', 'Sidecar identity or protocol is incompatible.');
      this.#fatal(error);
      throw error;
    }
    return result;
  }

  request<T>(method: string, params: unknown, schema: z.ZodType<T>, timeoutMs = this.#requestTimeout): Promise<T> {
    if (this.#failure) return Promise.reject(this.#failure);
    if (this.#disposed) return Promise.reject(new SidecarError('DISPOSED', 'Sidecar client is closed.'));
    if (this.#pending.size >= this.#pendingLimit) {
      return Promise.reject(new SidecarError('RESOURCE_LIMIT', 'Too many pending Sidecar requests.'));
    }
    const id = this.#nextId++;
    let line: Buffer;
    try {
      const request = sidecarRequestSchema.parse({ jsonrpc: '2.0', id, method, params });
      line = Buffer.from(`${JSON.stringify(request)}\n`, 'utf8');
      if (line.length > this.#lineLimit) {
        return Promise.reject(new SidecarError('RESOURCE_LIMIT', 'Sidecar request exceeds its line limit.'));
      }
    } catch {
      return Promise.reject(new SidecarError('PROTOCOL_ERROR', 'Invalid Sidecar request.'));
    }
    const stdin = this.#child.stdin;
    if (!stdin || stdin.destroyed || stdin.writableLength + line.length > this.#lineLimit * 2) {
      return Promise.reject(new SidecarError('RESOURCE_LIMIT', 'Sidecar input buffer is unavailable or full.'));
    }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.#fatal(new SidecarError('REQUEST_TIMEOUT', 'Sidecar request timed out.'));
        },
        bounded(timeoutMs, this.#requestTimeout, 10, 120_000),
      );
      this.#pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        schema,
        timer,
      });
      stdin.write(line, (error) => {
        if (error) this.#fatal(new SidecarError('PROCESS_EXIT', 'Sidecar input pipe failed.'));
      });
    });
  }

  async waitForClose(): Promise<void> {
    await this.#closed;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#rejectPending(new SidecarError('DISPOSED', 'Sidecar client is closed.'));
  }

  #readStdout(chunk: Buffer): void {
    if (this.#failure || this.#disposed) return;
    let cursor = 0;
    while (cursor < chunk.length) {
      const end = chunk.indexOf(0x0a, cursor);
      const part = chunk.subarray(cursor, end === -1 ? chunk.length : end);
      if (this.#stdoutBytes + part.length > this.#lineLimit) {
        this.#fatal(new SidecarError('RESOURCE_LIMIT', 'Sidecar output line exceeded its limit.'));
        return;
      }
      if (part.length > 0) {
        this.#stdoutParts.push(part);
        this.#stdoutBytes += part.length;
      }
      if (end === -1) return;
      const line = Buffer.concat(this.#stdoutParts, this.#stdoutBytes);
      this.#stdoutParts = [];
      this.#stdoutBytes = 0;
      cursor = end + 1;
      if (line.length > 0 && line.at(-1) === 0x0d) {
        this.#readLine(line.subarray(0, -1));
      } else {
        this.#readLine(line);
      }
      if (this.#failure) return;
    }
  }

  #readLine(bytes: Buffer): void {
    try {
      const message: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (typeof message === 'object' && message !== null && 'method' in message) {
        const notification = sidecarNotificationSchema.parse(message);
        if (notification.method === 'event') this.#onEvent?.(notification.params);
        // Diagnostic log frames are intentionally discarded: vendor output may contain credentials.
        return;
      }
      const response = sidecarResponseSchema.parse(message);
      if (response.id === null || typeof response.id !== 'number') throw new Error('Unexpected response ID.');
      const pending = this.#pending.get(response.id);
      if (!pending) throw new Error('Unknown response ID.');
      const result = 'error' in response ? undefined : pending.schema.parse(response.result);
      this.#pending.delete(response.id);
      clearTimeout(pending.timer);
      if ('error' in response) {
        pending.reject(new SidecarError('REMOTE_ERROR', 'Sidecar returned an error.'));
      } else {
        pending.resolve(result);
      }
    } catch {
      this.#fatal(new SidecarError('PROTOCOL_ERROR', 'Invalid Sidecar protocol frame.'));
    }
  }

  #fatal(error: SidecarError): void {
    if (this.#failure || this.#disposed) return;
    this.#failure = error;
    this.#rejectPending(error);
    this.#onFatal?.(error);
  }

  #rejectPending(error: SidecarError): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

function bounded(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) {
    throw new SidecarError('RESOURCE_LIMIT', 'Invalid Sidecar resource limit.');
  }
  return selected;
}
