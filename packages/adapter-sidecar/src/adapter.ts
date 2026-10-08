import { isDeepStrictEqual } from 'node:util';

import {
  adapterManifestSchema,
  harnessCapabilitiesSchema,
  type AdapterEvent,
  type AdapterManifest,
  type HarnessCapabilities,
  type InteractionResponse,
} from '@yanbot-harness/contracts';
import {
  assertRuntimeMatchesCapabilities,
  type AdapterProbeResult,
  type AdapterRunInput,
  type AdapterRuntime,
  type AdapterRuntimeContext,
  type HarnessAdapter,
  type ProbeContext,
} from '@yanbot-harness/adapter-api';
import { z } from 'zod';

import { modelsResultSchema, probeResultSchema } from './index.js';
import { SidecarError } from './client.js';
import { SidecarSupervisor, type SidecarSupervisorOptions } from './supervisor.js';

export type SidecarAdapterOptions = {
  manifest: AdapterManifest;
  launch: Omit<SidecarSupervisorOptions, 'expectedAdapterId' | 'expectedAdapterVersion' | 'onEvent' | 'onFatal'>;
  maxQueuedEvents?: number;
  runIdleTimeoutMs?: number;
};

const emptyResultSchema = z.object({});
const terminalTypes = new Set<AdapterEvent['type']>(['run.completed', 'run.failed', 'run.cancelled']);

/** Adapter SPI bridge for a pinned Sidecar Wrapper. Vendor parsing stays in the Wrapper. */
export class SidecarAdapter implements HarnessAdapter {
  readonly manifest: AdapterManifest;
  readonly #launch: SidecarAdapterOptions['launch'];
  readonly #maxQueuedEvents: number;
  readonly #runIdleTimeoutMs: number;

  constructor(options: SidecarAdapterOptions) {
    this.manifest = adapterManifestSchema.parse(options.manifest);
    if (!this.manifest.runtimeKinds.includes('sidecar')) {
      throw new SidecarError('PROTOCOL_ERROR', 'Sidecar manifest does not declare Sidecar support.');
    }
    this.#launch = options.launch;
    this.#maxQueuedEvents = options.maxQueuedEvents ?? 256;
    if (!Number.isSafeInteger(this.#maxQueuedEvents) || this.#maxQueuedEvents < 1 || this.#maxQueuedEvents > 10_000) {
      throw new SidecarError('RESOURCE_LIMIT', 'Invalid Sidecar event queue limit.');
    }
    this.#runIdleTimeoutMs = options.runIdleTimeoutMs ?? 120_000;
    if (
      !Number.isSafeInteger(this.#runIdleTimeoutMs) ||
      this.#runIdleTimeoutMs < 10 ||
      this.#runIdleTimeoutMs > 1_800_000
    ) {
      throw new SidecarError('RESOURCE_LIMIT', 'Invalid Sidecar Run idle timeout.');
    }
  }

  async probe(context: ProbeContext): Promise<AdapterProbeResult> {
    rejectUnmappedContext(context);
    const supervisor = await this.#start();
    try {
      const result = await supervisor.client.request('probe', {}, probeResultSchema);
      return {
        available: result.available,
        ...(result.harnessVersion === undefined ? {} : { harnessVersion: result.harnessVersion }),
        ...(result.diagnostics === undefined ? {} : { diagnostics: result.diagnostics }),
      };
    } finally {
      await supervisor.dispose();
    }
  }

  async createRuntime(context: AdapterRuntimeContext): Promise<AdapterRuntime> {
    rejectUnmappedContext(context);
    let active: EventQueue | undefined;
    let runtimeFailure: SidecarError | undefined;
    let intentionalClose = false;
    const supervisor = await this.#start({
      onEvent: (event) => {
        if (!active) throw new SidecarError('PROTOCOL_ERROR', 'Sidecar emitted an event without an active Run.');
        active.push(event);
      },
      onFatal: (error) => {
        if (!(intentionalClose && error.code === 'PROCESS_EXIT')) runtimeFailure ??= error;
        active?.fail(error);
      },
    });
    const capabilities = supervisor.client.initialization?.capabilities;
    if (!capabilities) {
      await supervisor.dispose();
      throw new SidecarError('PROTOCOL_ERROR', 'Sidecar initialization is missing.');
    }
    const client = supervisor.client;
    const maxQueuedEvents = this.#maxQueuedEvents;
    const runIdleTimeoutMs = this.#runIdleTimeoutMs;
    const timeoutMs = Math.min(1_000, this.#launch.requestTimeoutMs ?? 1_000);
    let stopped = false;
    const cancel = async (input: { runId: string; reason?: string }) => {
      if (!active || active.runId !== input.runId || active.terminalSeen) return;
      await client.request('cancel', input, emptyResultSchema, timeoutMs);
    };
    const run = (input: AdapterRunInput, resume: boolean): AsyncIterable<AdapterEvent> =>
      (async function* () {
        if (stopped) throw new SidecarError('DISPOSED', 'Sidecar Runtime is closed.');
        if (active) throw new SidecarError('PROTOCOL_ERROR', 'Sidecar Runtime already has an active Run.');
        if (input.abortSignal?.aborted) throw new SidecarError('DISPOSED', 'Run was aborted before start.');
        const queue = new EventQueue(input.runId, input.sessionId, maxQueuedEvents, runIdleTimeoutMs);
        active = queue;
        const { abortSignal, ...request } = input;
        let startAcknowledged = false;
        const onAbort = () => {
          if (startAcknowledged) {
            void cancel({ runId: input.runId, reason: 'Run aborted.' }).catch((error: unknown) => queue.fail(error));
          }
        };
        abortSignal?.addEventListener('abort', onAbort, { once: true });
        try {
          await client.request(resume ? 'resumeRun' : 'startRun', request, emptyResultSchema);
          startAcknowledged = true;
          if (abortSignal?.aborted) onAbort();
          for await (const event of queue.events()) {
            if (terminalTypes.has(event.type)) {
              const confirmed = await client.request('capabilities', {}, harnessCapabilitiesSchema);
              if (!isDeepStrictEqual(confirmed, capabilities))
                throw new SidecarError('PROTOCOL_ERROR', 'Sidecar capabilities changed during the Run.');
              if (runtimeFailure) throw runtimeFailure;
            }
            yield event;
          }
        } finally {
          abortSignal?.removeEventListener('abort', onAbort);
          if (!queue.terminalSeen && !client.failed) {
            await cancel({ runId: input.runId, reason: 'Run stream closed.' }).catch(() => undefined);
            stopped = true;
            intentionalClose = true;
            await supervisor.dispose();
          }
          active = undefined;
        }
      })();

    const runtime: AdapterRuntime = {
      capabilities: async () => capabilities,
      startRun: (input) => run(input, false),
      cancel,
      dispose: async () => {
        stopped = true;
        intentionalClose = true;
        if (active && !active.terminalSeen) {
          await cancel({ runId: active.runId, reason: 'Runtime disposed.' }).catch(() => undefined);
        }
        await supervisor.dispose();
        if (runtimeFailure) throw runtimeFailure;
      },
      ...(supported(capabilities, 'sessions.resume')
        ? { resumeRun: (input: AdapterRunInput & { adapterSessionId: string }) => run(input, true) }
        : {}),
      ...(supported(capabilities, 'models.list')
        ? {
            listModels: async (input?: { refresh?: boolean }) =>
              (await client.request('listModels', input ?? {}, modelsResultSchema)).models,
          }
        : {}),
      ...(supported(capabilities, 'interactions.permissions') || supported(capabilities, 'interactions.questions')
        ? {
            respondToInteraction: async (input: InteractionResponse) => {
              await client.request('respondToInteraction', input, emptyResultSchema);
            },
          }
        : {}),
    };
    try {
      await assertRuntimeMatchesCapabilities(runtime);
      return runtime;
    } catch (error) {
      await supervisor.dispose().catch(() => undefined);
      throw error;
    }
  }

  async #start(callbacks: Pick<SidecarSupervisorOptions, 'onEvent' | 'onFatal'> = {}): Promise<SidecarSupervisor> {
    const supervisor = await SidecarSupervisor.start({
      ...this.#launch,
      ...callbacks,
      expectedAdapterId: this.manifest.adapterId,
      expectedAdapterVersion: this.manifest.adapterVersion,
    });
    if (!isDeepStrictEqual(supervisor.client.initialization?.manifest, this.manifest)) {
      await supervisor.dispose();
      throw new SidecarError('PROTOCOL_ERROR', 'Sidecar manifest differs from the pinned manifest.');
    }
    return supervisor;
  }
}

class EventQueue {
  readonly runId: string;
  readonly #sessionId: string;
  readonly #limit: number;
  readonly #idleTimeoutMs: number;
  readonly #events: AdapterEvent[] = [];
  #sequence = 0;
  #terminal = false;
  #failure: unknown;
  #wake: (() => void) | undefined;

  constructor(runId: string, sessionId: string, limit: number, idleTimeoutMs: number) {
    this.runId = runId;
    this.#sessionId = sessionId;
    this.#limit = limit;
    this.#idleTimeoutMs = idleTimeoutMs;
  }

  get terminalSeen(): boolean {
    return this.#terminal;
  }

  push(event: AdapterEvent): void {
    if (event.runId !== this.runId || event.sessionId !== this.#sessionId) {
      throw new SidecarError('PROTOCOL_ERROR', 'Sidecar Event belongs to another Run or Session.');
    }
    if (event.sequence !== this.#sequence + 1 || this.#terminal) {
      throw new SidecarError('PROTOCOL_ERROR', 'Sidecar Event sequence or terminal state is invalid.');
    }
    if (this.#sequence === 0 && event.type !== 'run.started') {
      throw new SidecarError('PROTOCOL_ERROR', 'Sidecar Run must start with run.started.');
    }
    if (this.#events.length >= this.#limit) {
      throw new SidecarError('RESOURCE_LIMIT', 'Sidecar Event queue exceeded its limit.');
    }
    this.#sequence = event.sequence;
    this.#terminal = terminalTypes.has(event.type);
    this.#events.push(event);
    this.#wake?.();
    this.#wake = undefined;
  }

  fail(error: unknown): void {
    this.#failure ??= error;
    this.#wake?.();
    this.#wake = undefined;
  }

  async *events(): AsyncGenerator<AdapterEvent> {
    for (;;) {
      if (this.#failure) throw this.#failure;
      const event = this.#events.shift();
      if (event) {
        yield event;
        if (terminalTypes.has(event.type)) return;
      } else {
        let timer: NodeJS.Timeout | undefined;
        try {
          await new Promise<void>((resolve, reject) => {
            this.#wake = resolve;
            timer = setTimeout(() => {
              this.#wake = undefined;
              reject(new SidecarError('REQUEST_TIMEOUT', 'Sidecar Run event idle timeout.'));
            }, this.#idleTimeoutMs);
          });
        } finally {
          clearTimeout(timer);
        }
      }
    }
  }
}

function supported(capabilities: HarnessCapabilities, capability: keyof HarnessCapabilities): boolean {
  const level = capabilities[capability]?.level;
  return level !== undefined && level !== 'unsupported';
}

function rejectUnmappedContext(context: AdapterRuntimeContext): void {
  if (Object.keys(context.credentials ?? {}).length > 0 || Object.keys(context.config ?? {}).length > 0) {
    throw new SidecarError('PROTOCOL_ERROR', 'Sidecar context must be applied by the trusted launch environment.');
  }
}
