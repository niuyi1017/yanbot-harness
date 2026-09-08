import type { AdapterEvent, AdapterSummary, LocalRun, LocalSession, ModelDescriptor } from '@yanbot-harness/sdk';

export type CliIo = {
  stdout: Pick<NodeJS.WritableStream, 'write'>;
  stderr: Pick<NodeJS.WritableStream, 'write'>;
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
};

export function writeJson(io: CliIo, value: unknown): void {
  io.stdout.write(`${JSON.stringify(value)}\n`);
}

export function writeAdapters(io: CliIo, adapters: readonly AdapterSummary[], json: boolean): void {
  if (json) return writeJson(io, adapters);
  for (const adapter of adapters) io.stdout.write(`${adapter.manifest.adapterId}\t${adapter.manifest.displayName}\n`);
}

export function writeModels(io: CliIo, models: readonly ModelDescriptor[], json: boolean): void {
  if (json) return writeJson(io, models);
  for (const model of models) io.stdout.write(`${model.ref.modelId}\t${model.name}\n`);
}

export function writeSessions(io: CliIo, sessions: readonly LocalSession[], json: boolean): void {
  if (json) return writeJson(io, sessions);
  for (const session of sessions) io.stdout.write(`${session.sessionId}\t${session.status}\t${session.adapterId}\n`);
}

export function writeRun(io: CliIo, run: LocalRun, json: boolean): void {
  if (json) return writeJson(io, run);
  io.stdout.write(`${run.runId}\t${run.status}\t${run.adapterId}\n`);
}

export class EventRenderer {
  readonly #io: CliIo;
  readonly #json: boolean;
  readonly #logLevel: 'silent' | 'error' | 'info' | 'debug';
  #wroteDelta = false;

  constructor(io: CliIo, options: { json: boolean; logLevel: 'silent' | 'error' | 'info' | 'debug' }) {
    this.#io = io;
    this.#json = options.json;
    this.#logLevel = options.logLevel;
  }

  event(event: AdapterEvent): void {
    if (this.#json) return writeJson(this.#io, event);
    if (event.type === 'assistant.delta' && event.payload.channel === 'output') {
      this.#io.stdout.write(event.payload.text);
      this.#wroteDelta = true;
    } else if (event.type === 'assistant.message' && !this.#wroteDelta) {
      this.#io.stdout.write(event.payload.text);
    } else if (event.type === 'tool.started') {
      this.info(`tool: ${event.payload.name}`);
    } else if (event.type === 'usage.updated' && this.#logLevel === 'debug') {
      this.info(`usage: ${JSON.stringify(event.payload)}`);
    }
    if (isTerminal(event) && this.#wroteDelta) this.#io.stdout.write('\n');
  }

  info(message: string): void {
    if (this.#logLevel === 'info' || this.#logLevel === 'debug') this.#io.stderr.write(`${message}\n`);
  }
}

export function isTerminal(event: AdapterEvent): boolean {
  return event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.cancelled';
}
