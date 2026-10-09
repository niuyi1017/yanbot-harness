import { randomUUID } from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';
import { TextDecoder } from 'node:util';
import type { SendFrame } from './protocol.js';

export type SaveCheckpoint = (snapshot: unknown) => Promise<void>;
const limit = 32 * 1024 * 1024;

/** Private state frames never enter the public Sidecar/event parser. */
export class HostCheckpointChannel extends Transform {
  #buffer = Buffer.alloc(0);
  #used = false;
  constructor(
    private readonly save: SaveCheckpoint,
    private readonly send: SendFrame,
  ) {
    super();
  }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    try {
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
      for (;;) {
        const end = this.#buffer.indexOf(10);
        if (end < 0) break;
        if (end > limit) throw new Error();
        const line = this.#buffer.subarray(0, end);
        this.#buffer = this.#buffer.subarray(end + 1);
        const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line));
        if (
          value &&
          typeof value === 'object' &&
          'method' in value &&
          typeof value.method === 'string' &&
          value.method.startsWith('state.')
        ) {
          if (
            this.#used ||
            value.method !== 'state.save' ||
            !('id' in value) ||
            typeof value.id !== 'string' ||
            !/^[0-9a-f-]{36}$/u.test(value.id) ||
            !('snapshot' in value) ||
            Object.keys(value).length !== 3
          )
            throw new Error();
          this.#used = true;
          const id = value.id;
          void this.save(value.snapshot)
            .then(
              () => this.send({ method: 'state.saved', id, ok: true }),
              () => this.send({ method: 'state.saved', id, ok: false }),
            )
            .catch(() => this.destroy(new Error('Checkpoint channel failed.')));
        } else {
          if (line.length > 4 * 1024 * 1024) throw new Error();
          this.push(Buffer.concat([line, Buffer.from('\n')]));
        }
      }
      if (this.#buffer.length > limit) throw new Error();
      done();
    } catch {
      done(new Error('Invalid checkpoint channel frame.'));
    }
  }
  override _flush(done: TransformCallback): void {
    done(this.#buffer.length ? new Error('Truncated checkpoint frame.') : undefined);
  }
}

export class GuestCheckpointChannel {
  #pending: { id: string; resolve(): void; reject(error: Error): void } | undefined;
  #used = false;
  constructor(private readonly send: SendFrame) {}
  async save(snapshot: unknown): Promise<void> {
    if (this.#used) throw new Error('Checkpoint already attempted.');
    this.#used = true;
    const id = randomUUID();
    const frame = { method: 'state.save', id, snapshot };
    if (Buffer.byteLength(JSON.stringify(frame)) > limit) throw new Error('Checkpoint limit.');
    let timer: NodeJS.Timeout | undefined;
    const ack = new Promise<void>((resolve, reject) => {
      this.#pending = { id, resolve, reject };
      timer = setTimeout(() => reject(new Error('Checkpoint acknowledgement timeout.')), 30_000);
    });
    try {
      await Promise.all([this.send(frame), ack]);
    } finally {
      clearTimeout(timer);
      this.#pending = undefined;
    }
  }
  accept(value: unknown): void {
    if (
      !value ||
      typeof value !== 'object' ||
      !('method' in value) ||
      value.method !== 'state.saved' ||
      !('id' in value) ||
      value.id !== this.#pending?.id ||
      !('ok' in value) ||
      typeof value.ok !== 'boolean' ||
      Object.keys(value).length !== 3
    )
      throw new Error('Invalid checkpoint acknowledgement.');
    const pending = this.#pending;
    if (!pending) throw new Error('Unexpected checkpoint acknowledgement.');
    this.#pending = undefined;
    if (value.ok) pending.resolve();
    else pending.reject(new Error('Checkpoint save failed.'));
  }
  close(): void {
    this.#pending?.reject(new Error('Checkpoint channel closed.'));
    this.#pending = undefined;
  }
}
