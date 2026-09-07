import {
  adapterEventSchema,
  interactionResponseSchema,
  type AdapterEvent,
  type InteractionRequest,
  type InteractionResponse,
  type RunRequest,
} from '@yanbot-harness/contracts';
import {
  HarnessAdapterError,
  assertRuntimeMatchesCapabilities,
  type AdapterRuntime,
  type AdapterRuntimeContext,
  type HarnessAdapter,
} from '@yanbot-harness/adapter-api';

const terminalEventTypes = new Set<AdapterEvent['type']>(['run.completed', 'run.failed', 'run.cancelled']);

export interface ManagedRunController {
  readonly events: AsyncIterable<AdapterEvent>;
  respond(response: InteractionResponse): Promise<void>;
  cancel(reason?: string): Promise<void>;
  dispose(): Promise<void>;
}

export async function createManagedAdapterRun(
  adapter: HarnessAdapter,
  context: AdapterRuntimeContext,
  request: RunRequest,
): Promise<ManagedRunController> {
  const runtime = await adapter.createRuntime(context);
  try {
    await assertRuntimeMatchesCapabilities(runtime);
    const source = request.adapterSessionId
      ? runtime.resumeRun?.({ ...request, adapterSessionId: request.adapterSessionId })
      : runtime.startRun(request);
    if (!source) {
      throw new HarnessAdapterError({
        code: 'CAPABILITY_UNSUPPORTED',
        message: `Adapter ${adapter.manifest.adapterId} cannot resume sessions.`,
        retryable: false,
      });
    }
    return new ManagedAdapterRun(runtime, source, request);
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}

export async function* executeAdapterRun(
  adapter: HarnessAdapter,
  context: AdapterRuntimeContext,
  request: RunRequest,
): AsyncIterable<AdapterEvent> {
  const controller = await createManagedAdapterRun(adapter, context, request);
  yield* controller.events;
}

class ManagedAdapterRun implements ManagedRunController {
  readonly events: AsyncIterable<AdapterEvent>;

  readonly #runtime: AdapterRuntime;
  readonly #request: RunRequest;
  readonly #source: AsyncIterable<AdapterEvent>;
  readonly #pending = new Map<string, InteractionRequest['kind']>();
  readonly #responses = new Map<string, string>();
  readonly #responseOperations = new Map<string, { serialized: string; promise: Promise<void> }>();
  #cancelPromise: Promise<void> | undefined;
  #disposePromise: Promise<void> | undefined;
  #terminalSeen = false;
  #iterationStarted = false;

  constructor(runtime: AdapterRuntime, source: AsyncIterable<AdapterEvent>, request: RunRequest) {
    this.#runtime = runtime;
    this.#source = source;
    this.#request = request;
    this.events = { [Symbol.asyncIterator]: () => this.#iterate() };
  }

  async respond(response: InteractionResponse): Promise<void> {
    const parsed = interactionResponseSchema.safeParse(response);
    if (!parsed.success) {
      throw new HarnessAdapterError({
        code: 'CONFIGURATION_INVALID',
        message: 'The interaction response is invalid.',
        retryable: false,
      });
    }
    const serialized = JSON.stringify(parsed.data);
    const completed = this.#responses.get(parsed.data.requestId);
    if (completed !== undefined) {
      if (completed === serialized) return;
      throw interactionExpired(parsed.data.requestId, 'The interaction already has a different response.');
    }
    if (this.#terminalSeen || this.#disposePromise) throw interactionExpired(parsed.data.requestId);
    const activeOperation = this.#responseOperations.get(parsed.data.requestId);
    if (activeOperation) {
      if (activeOperation.serialized !== serialized) {
        throw interactionExpired(parsed.data.requestId, 'The interaction is already receiving a different response.');
      }
      await activeOperation.promise;
      return;
    }
    const kind = this.#pending.get(parsed.data.requestId);
    if (!kind) throw interactionExpired(parsed.data.requestId);
    assertResponseMatchesInteraction(kind, parsed.data);
    if (!this.#runtime.respondToInteraction) {
      throw new HarnessAdapterError({
        code: 'CAPABILITY_UNSUPPORTED',
        message: 'The adapter does not support interaction responses.',
        retryable: false,
      });
    }

    const operation = this.#runtime.respondToInteraction(parsed.data).then(() => {
      this.#responses.set(parsed.data.requestId, serialized);
    });
    this.#responseOperations.set(parsed.data.requestId, { serialized, promise: operation });
    try {
      await operation;
    } finally {
      this.#responseOperations.delete(parsed.data.requestId);
    }
  }

  async cancel(reason?: string): Promise<void> {
    if (this.#terminalSeen || this.#disposePromise) return;
    this.#cancelPromise ??= this.#runtime.cancel({
      runId: this.#request.runId,
      ...(reason === undefined ? {} : { reason }),
    });
    await this.#cancelPromise;
  }

  async dispose(): Promise<void> {
    this.#disposePromise ??= this.#runtime.dispose();
    await this.#disposePromise;
  }

  async *#iterate(): AsyncGenerator<AdapterEvent> {
    if (this.#iterationStarted) throw protocolError('A managed run event stream can only be consumed once.');
    this.#iterationStarted = true;
    let expectedSequence = 1;

    try {
      for await (const rawEvent of this.#source) {
        const parsed = adapterEventSchema.safeParse(rawEvent);
        if (!parsed.success) throw protocolError('Adapter emitted an event that does not match the public schema.');
        const event = parsed.data;
        if (event.runId !== this.#request.runId || event.sessionId !== this.#request.sessionId) {
          throw protocolError('Adapter emitted an event for a different run or session.');
        }
        if (event.sequence !== expectedSequence) {
          throw protocolError(`Expected event sequence ${expectedSequence}, received ${event.sequence}.`);
        }
        if (expectedSequence === 1 && event.type !== 'run.started') {
          throw protocolError('The first event must be run.started.');
        }
        if (this.#terminalSeen) throw protocolError('Adapter emitted an event after a terminal event.');

        expectedSequence += 1;
        if (event.type === 'interaction.requested') {
          if (this.#pending.has(event.payload.requestId) || this.#responses.has(event.payload.requestId)) {
            throw protocolError(`Adapter emitted duplicate interaction ${event.payload.requestId}.`);
          }
          this.#pending.set(event.payload.requestId, event.payload.kind);
        }
        if (event.type === 'interaction.resolved') {
          if (!this.#pending.delete(event.payload.requestId)) {
            throw protocolError(`Adapter resolved unknown interaction ${event.payload.requestId}.`);
          }
        }
        const terminal = terminalEventTypes.has(event.type);
        if (terminal && this.#pending.size > 0) {
          throw protocolError('Adapter ended the run while interactions were still pending.');
        }
        this.#terminalSeen = terminal;
        if (this.#terminalSeen) this.#pending.clear();
        yield event;
      }

      if (!this.#terminalSeen) throw protocolError('Adapter stream ended without a terminal event.');
    } finally {
      await this.dispose();
    }
  }
}

function assertResponseMatchesInteraction(kind: InteractionRequest['kind'], response: InteractionResponse): void {
  const valid =
    kind === 'permission'
      ? response.action === 'allow' || response.action === 'deny'
      : response.action === 'submit' || response.action === 'deny';
  if (!valid) {
    throw new HarnessAdapterError({
      code: 'CONFIGURATION_INVALID',
      message: `The ${response.action} action is invalid for a ${kind} interaction.`,
      retryable: false,
    });
  }
}

function interactionExpired(requestId: string, message?: string): HarnessAdapterError {
  return new HarnessAdapterError({
    code: 'INTERACTION_EXPIRED',
    message: message ?? `Interaction ${requestId} does not exist or has already resolved.`,
    retryable: false,
  });
}

function protocolError(message: string): HarnessAdapterError {
  return new HarnessAdapterError({ code: 'HARNESS_PROTOCOL_ERROR', message, retryable: false });
}
