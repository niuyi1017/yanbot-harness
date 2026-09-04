import {
  HARNESS_PROTOCOL_VERSION,
  type AdapterEvent,
  type AdapterManifest,
  type HarnessCapabilities,
  type HarnessErrorCode,
  type InteractionResponse,
  type JsonValue,
} from '@yanbot-harness/contracts';
import type { AdapterProbeResult, AdapterRunInput, AdapterRuntime, HarnessAdapter } from '@yanbot-harness/adapter-api';
import { AdapterEventFactory } from '@yanbot-harness/adapter-kit';

export type ReferenceScenario =
  | { kind: 'text'; chunks: readonly string[] }
  | { kind: 'tool'; toolName: string; result: JsonValue }
  | { kind: 'permission'; toolName: string; allowResult: string }
  | { kind: 'question'; prompt: string; answerResult: string }
  | { kind: 'failure'; code: HarnessErrorCode }
  | { kind: 'wait-for-cancel' };

export type ReferenceAdapterOptions = {
  scenario?: ReferenceScenario;
  now?: () => Date;
  generateId?: () => string;
};

const capabilities: HarnessCapabilities = {
  'sessions.resume': { level: 'emulated' },
  'runs.cancel': { level: 'native' },
  'streaming.text': { level: 'native' },
  'streaming.tool-events': { level: 'native' },
  'interactions.permissions': { level: 'native' },
  'interactions.questions': { level: 'native' },
  'models.list': { level: 'native' },
  'usage.tokens': { level: 'emulated' },
  'usage.cost': { level: 'unsupported', reason: 'The offline reference adapter never incurs cost.' },
};

export class ReferenceAdapter implements HarnessAdapter {
  readonly manifest: AdapterManifest = {
    protocolVersion: HARNESS_PROTOCOL_VERSION,
    adapterId: 'cn.yanbot.reference',
    adapterVersion: '0.1.0',
    displayName: 'Yanbot Reference Adapter',
    harness: { name: 'Deterministic Reference Harness', version: '0.1.0' },
    runtimeKinds: ['in-process'],
  };

  readonly #options: ReferenceAdapterOptions;

  constructor(options: ReferenceAdapterOptions = {}) {
    this.#options = options;
  }

  async probe(): Promise<AdapterProbeResult> {
    return { available: true, harnessVersion: '0.1.0' };
  }

  async createRuntime(): Promise<AdapterRuntime> {
    return new ReferenceRuntime(this.#options);
  }
}

class ReferenceRuntime implements AdapterRuntime {
  readonly #scenario: ReferenceScenario;
  readonly #now: (() => Date) | undefined;
  readonly #generateId: (() => string) | undefined;
  #disposed = false;
  #activeRunId: string | undefined;
  #cancelReason = 'Run cancelled.';
  #resolveCancellation: (() => void) | undefined;
  #cancellation = Promise.resolve();
  #pendingInteraction:
    | {
        requestId: string;
        resolve: (response: InteractionResponse) => void;
      }
    | undefined;

  constructor(options: ReferenceAdapterOptions) {
    this.#scenario = options.scenario ?? { kind: 'text', chunks: ['Reference response.'] };
    this.#now = options.now;
    this.#generateId = options.generateId;
  }

  async capabilities(): Promise<HarnessCapabilities> {
    return capabilities;
  }

  async listModels() {
    return [
      {
        ref: { adapterId: 'cn.yanbot.reference', modelId: 'deterministic' },
        name: 'Deterministic Reference Model',
        description: 'Offline model used for protocol and client tests.',
      },
    ];
  }

  startRun(input: AdapterRunInput): AsyncIterable<AdapterEvent> {
    return this.#run(input);
  }

  resumeRun(input: AdapterRunInput & { adapterSessionId: string }): AsyncIterable<AdapterEvent> {
    return this.#run(input);
  }

  async respondToInteraction(response: InteractionResponse): Promise<void> {
    if (!this.#pendingInteraction || this.#pendingInteraction.requestId !== response.requestId) {
      throw new Error('The reference interaction does not exist or has already resolved.');
    }
    const pending = this.#pendingInteraction;
    this.#pendingInteraction = undefined;
    pending.resolve(response);
  }

  async cancel(input: { runId: string; reason?: string }): Promise<void> {
    if (this.#activeRunId !== input.runId) return;
    this.#cancelReason = input.reason ?? this.#cancelReason;
    this.#resolveCancellation?.();
    if (this.#pendingInteraction) {
      const pending = this.#pendingInteraction;
      this.#pendingInteraction = undefined;
      pending.resolve({ requestId: pending.requestId, action: 'deny', message: this.#cancelReason });
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#resolveCancellation?.();
    if (this.#pendingInteraction) {
      const pending = this.#pendingInteraction;
      this.#pendingInteraction = undefined;
      pending.resolve({ requestId: pending.requestId, action: 'deny', message: 'Runtime disposed.' });
    }
  }

  async *#run(input: AdapterRunInput): AsyncIterable<AdapterEvent> {
    if (this.#disposed) throw new Error('The reference runtime has been disposed.');
    if (this.#activeRunId) throw new Error('The reference runtime only supports one active run.');

    this.#activeRunId = input.runId;
    this.#cancellation = new Promise<void>((resolve) => {
      this.#resolveCancellation = resolve;
    });
    const factory = new AdapterEventFactory({
      runId: input.runId,
      sessionId: input.sessionId,
      ...(this.#now === undefined ? {} : { now: this.#now }),
      ...(this.#generateId === undefined ? {} : { generateId: this.#generateId }),
    });

    try {
      yield factory.create('run.started', {
        adapterId: this.manifestAdapterId,
        ...(input.model === undefined ? {} : { model: input.model }),
      });
      yield factory.create('session.initialized', {
        adapterSessionId: input.adapterSessionId ?? `reference:${input.sessionId}`,
        capabilities,
      });

      switch (this.#scenario.kind) {
        case 'text': {
          for (const chunk of this.#scenario.chunks) {
            if (chunk) yield factory.create('assistant.delta', { channel: 'output', text: chunk });
          }
          const text = this.#scenario.chunks.join('');
          yield factory.create('assistant.message', { text });
          yield factory.create('usage.updated', { outputTokens: text.length, turns: 1 });
          yield factory.create('run.completed', { usage: { outputTokens: text.length, turns: 1 } });
          break;
        }
        case 'tool': {
          const toolUseId = `tool:${input.runId}`;
          yield factory.create('tool.started', { toolUseId, name: this.#scenario.toolName });
          yield factory.create('tool.completed', { toolUseId, outputSummary: this.#scenario.result });
          yield factory.create('run.completed', {});
          break;
        }
        case 'permission': {
          const requestId = `permission:${input.runId}`;
          const responsePromise = this.#waitForInteraction(requestId);
          yield factory.create('interaction.requested', {
            kind: 'permission',
            requestId,
            toolName: this.#scenario.toolName,
            risk: 'high',
          });
          const response = await responsePromise;
          const allowed = response.action === 'allow';
          yield factory.create('interaction.resolved', {
            requestId,
            outcome: allowed ? 'allowed' : 'denied',
          });
          if (allowed) {
            yield factory.create('assistant.message', { text: this.#scenario.allowResult });
            yield factory.create('run.completed', {});
          } else {
            yield factory.create('run.failed', {
              error: { code: 'PERMISSION_DENIED', message: response.message ?? 'Permission denied.', retryable: false },
            });
          }
          break;
        }
        case 'question': {
          const requestId = `question:${input.runId}`;
          const questionId = `question-item:${input.runId}`;
          const responsePromise = this.#waitForInteraction(requestId);
          yield factory.create('interaction.requested', {
            kind: 'question',
            requestId,
            questions: [{ id: questionId, prompt: this.#scenario.prompt }],
          });
          const response = await responsePromise;
          const answered = response.action === 'submit' && Boolean(response.answers?.[questionId]);
          yield factory.create('interaction.resolved', {
            requestId,
            outcome: answered ? 'answered' : 'denied',
          });
          if (answered) {
            yield factory.create('assistant.message', { text: this.#scenario.answerResult });
            yield factory.create('run.completed', {});
          } else {
            yield factory.create('run.failed', {
              error: {
                code: 'PERMISSION_DENIED',
                message: response.message ?? 'Question was not answered.',
                retryable: false,
              },
            });
          }
          break;
        }
        case 'failure':
          yield factory.create('run.failed', {
            error: { code: this.#scenario.code, message: 'Reference failure.', retryable: false },
          });
          break;
        case 'wait-for-cancel':
          await this.#cancellation;
          yield factory.create('run.cancelled', { reason: this.#cancelReason });
          break;
      }
    } finally {
      this.#activeRunId = undefined;
      this.#resolveCancellation = undefined;
      this.#pendingInteraction = undefined;
    }
  }

  get manifestAdapterId(): string {
    return 'cn.yanbot.reference';
  }

  async #waitForInteraction(requestId: string): Promise<InteractionResponse> {
    return new Promise((resolve) => {
      this.#pendingInteraction = { requestId, resolve };
    });
  }
}
