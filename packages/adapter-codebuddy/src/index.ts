import {
  HARNESS_PROTOCOL_VERSION,
  type AdapterEvent,
  type AdapterManifest,
  type ConfigScope,
  type HarnessCapabilities,
  type HarnessError,
  type InteractionResponse,
  type JsonValue,
} from '@yanbot-harness/contracts';
import type {
  AdapterProbeResult,
  AdapterRunInput,
  AdapterRuntime,
  AdapterRuntimeContext,
  HarnessAdapter,
} from '@yanbot-harness/adapter-api';
import { HarnessAdapterError } from '@yanbot-harness/adapter-api';
import { AdapterEventFactory } from '@yanbot-harness/adapter-kit';

import { AsyncQueue } from './async-queue.js';
import {
  defaultCodeBuddySdkFacade,
  type CodeBuddyCanUseTool,
  type CodeBuddyPermissionResult,
  type CodeBuddyQueryInput,
  type CodeBuddyQueryStream,
  type CodeBuddySdkFacade,
} from './sdk-facade.js';

export type {
  CodeBuddyCanUseTool,
  CodeBuddyModelInput,
  CodeBuddyPermissionResult,
  CodeBuddyQueryInput,
  CodeBuddyQueryStream,
  CodeBuddySdkFacade,
} from './sdk-facade.js';

const ADAPTER_ID = 'cn.tencent.codebuddy';
const SDK_VERSION = '0.3.254';
const credentialKeys = ['CODEBUDDY_API_KEY'] as const;
const DEFAULT_RUN_TIMEOUT_MS = 30 * 60 * 1_000;
const DEFAULT_IDLE_TIMEOUT_MS = 2 * 60 * 1_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 5_000;
const DEFAULT_TERMINAL_SIGNAL_GRACE_MS = 5_000;

const capabilities: HarnessCapabilities = {
  'sessions.resume': { level: 'native' },
  'runs.cancel': { level: 'native' },
  'streaming.text': { level: 'native' },
  'streaming.tool-events': { level: 'native' },
  'interactions.permissions': { level: 'native' },
  'interactions.questions': { level: 'native' },
  'extensions.mcp': { level: 'unsupported', reason: 'Extension translation is deferred.' },
  'extensions.skills': { level: 'unsupported', reason: 'Extension translation is deferred.' },
  'extensions.agents': { level: 'unsupported', reason: 'Extension translation is deferred.' },
  'extensions.hooks': { level: 'unsupported', reason: 'Extension translation is deferred.' },
  'models.list': {
    level: 'unsupported',
    reason: 'CodeBuddy SDK 0.3.254 model discovery does not release its CLI subprocess reliably.',
  },
  'usage.tokens': { level: 'native' },
  'usage.cost': { level: 'native' },
};

export type CodeBuddyAdapterOptions = {
  sdk?: CodeBuddySdkFacade;
  now?: () => Date;
  generateId?: () => string;
  runTimeoutMs?: number;
  idleTimeoutMs?: number;
  shutdownGraceMs?: number;
  terminalSignalGraceMs?: number;
};

export class CodeBuddyAdapter implements HarnessAdapter {
  readonly manifest: AdapterManifest = {
    protocolVersion: HARNESS_PROTOCOL_VERSION,
    adapterId: ADAPTER_ID,
    adapterVersion: '0.1.0',
    displayName: 'CodeBuddy Adapter',
    harness: { name: 'CodeBuddy Agent SDK', version: SDK_VERSION },
    runtimeKinds: ['in-process'],
    configSchema: {
      type: 'object',
      properties: {
        internetEnvironment: { type: 'string' },
        baseUrl: { type: 'string' },
        pathToCodebuddyCode: { type: 'string' },
        systemPrompt: { type: 'string' },
        runTimeoutMs: { type: 'integer', minimum: 1_000, maximum: 86_400_000 },
        idleTimeoutMs: { type: 'integer', minimum: 1_000, maximum: 3_600_000 },
        shutdownGraceMs: { type: 'integer', minimum: 1, maximum: 60_000 },
      },
      additionalProperties: false,
    },
  };

  readonly #options: CodeBuddyAdapterOptions;

  constructor(options: CodeBuddyAdapterOptions = {}) {
    this.#options = options;
  }

  async probe(context: AdapterRuntimeContext): Promise<AdapterProbeResult> {
    const missing = credentialKeys.filter((key) => !context.credentials?.[key]);
    return missing.length === 0
      ? { available: true, harnessVersion: SDK_VERSION }
      : {
          available: false,
          harnessVersion: SDK_VERSION,
          diagnostics: missing.map((key) => `Missing credential: ${key}`),
        };
  }

  async createRuntime(context: AdapterRuntimeContext): Promise<AdapterRuntime> {
    return new CodeBuddyRuntime(context, this.#options);
  }
}

type PendingInteraction = {
  kind: 'permission' | 'question';
  input: Record<string, unknown>;
  questionKeys?: Readonly<Record<string, string>>;
  resolve: (result: CodeBuddyPermissionResult) => void;
};

type ActiveRun = {
  runId: string;
  abortController: AbortController;
  stream: CodeBuddyQueryStream;
  queue: AsyncQueue<AdapterEvent>;
  factory: AdapterEventFactory;
  cancelled: boolean;
  cancelReason: string;
  terminal: boolean;
  lastActivityAt: number;
  runningTools: Map<string, string>;
  settledTools: Set<string>;
  pendingFailure?: HarnessError;
  pendingFailureAt?: number;
  stopPromise?: Promise<void>;
};

class CodeBuddyRuntime implements AdapterRuntime {
  readonly #context: AdapterRuntimeContext;
  readonly #sdk: CodeBuddySdkFacade;
  readonly #now: (() => Date) | undefined;
  readonly #generateId: (() => string) | undefined;
  readonly #runTimeoutMs: number;
  readonly #idleTimeoutMs: number;
  readonly #shutdownGraceMs: number;
  readonly #terminalSignalGraceMs: number;
  readonly #pendingInteractions = new Map<string, PendingInteraction>();
  #active: ActiveRun | undefined;
  #disposed = false;

  constructor(context: AdapterRuntimeContext, options: CodeBuddyAdapterOptions) {
    this.#context = context;
    this.#sdk = options.sdk ?? defaultCodeBuddySdkFacade;
    this.#now = options.now;
    this.#generateId = options.generateId;
    this.#runTimeoutMs = positiveInteger(
      options.runTimeoutMs ?? this.#context.config?.runTimeoutMs,
      DEFAULT_RUN_TIMEOUT_MS,
    );
    this.#idleTimeoutMs = positiveInteger(
      options.idleTimeoutMs ?? this.#context.config?.idleTimeoutMs,
      DEFAULT_IDLE_TIMEOUT_MS,
    );
    this.#shutdownGraceMs = positiveInteger(
      options.shutdownGraceMs ?? this.#context.config?.shutdownGraceMs,
      DEFAULT_SHUTDOWN_GRACE_MS,
    );
    this.#terminalSignalGraceMs = positiveInteger(options.terminalSignalGraceMs, DEFAULT_TERMINAL_SIGNAL_GRACE_MS);
  }

  async capabilities(): Promise<HarnessCapabilities> {
    return capabilities;
  }

  startRun(input: AdapterRunInput): AsyncIterable<AdapterEvent> {
    return this.#run(input);
  }

  resumeRun(input: AdapterRunInput & { adapterSessionId: string }): AsyncIterable<AdapterEvent> {
    return this.#run(input);
  }

  async respondToInteraction(response: InteractionResponse): Promise<void> {
    const pending = this.#pendingInteractions.get(response.requestId);
    if (!pending || !this.#active) {
      throw new HarnessAdapterError({
        code: 'INTERACTION_EXPIRED',
        message: 'The CodeBuddy interaction does not exist or has already resolved.',
        retryable: false,
      });
    }
    this.#pendingInteractions.delete(response.requestId);
    this.#active.lastActivityAt = Date.now();

    let result: CodeBuddyPermissionResult;
    let outcome: 'allowed' | 'denied' | 'answered';
    if (response.action === 'allow' && pending.kind === 'permission') {
      result = { behavior: 'allow', updatedInput: pending.input };
      outcome = 'allowed';
    } else if (
      response.action === 'submit' &&
      pending.kind === 'question' &&
      pending.questionKeys &&
      response.answers
    ) {
      const answers = Object.fromEntries(
        Object.entries(response.answers).map(([key, value]) => [pending.questionKeys?.[key] ?? key, value]),
      );
      result = { behavior: 'allow', updatedInput: { ...pending.input, answers } };
      outcome = 'answered';
    } else {
      result = { behavior: 'deny', message: response.message ?? 'Interaction denied.' };
      outcome = 'denied';
    }
    this.#active.queue.push(
      this.#active.factory.create('interaction.resolved', { requestId: response.requestId, outcome }),
    );
    pending.resolve(result);
  }

  async cancel(input: { runId: string; reason?: string }): Promise<void> {
    const active = this.#active;
    if (!active || active.runId !== input.runId || active.terminal) return;
    active.cancelled = true;
    active.cancelReason = input.reason ?? 'Run cancelled.';
    this.#settleRunningTools(active.runningTools, active.settledTools, active.queue, active.factory, true);
    this.#resolvePendingInteractions(active, active.cancelReason);
    this.#emitTerminal(active, active.factory.create('run.cancelled', { reason: active.cancelReason }));
    await this.#stopVendor(active);
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#active) await this.cancel({ runId: this.#active.runId, reason: 'Runtime disposed.' });
  }

  async *#run(input: AdapterRunInput): AsyncIterable<AdapterEvent> {
    this.#assertUsable();
    if (this.#active) throw new Error('The CodeBuddy runtime only supports one active run.');
    if (input.model && input.model.adapterId !== ADAPTER_ID) {
      throw new HarnessAdapterError({
        code: 'CONFIGURATION_INVALID',
        message: `Model ${input.model.modelId} belongs to another adapter.`,
        retryable: false,
      });
    }

    const factory = new AdapterEventFactory({
      runId: input.runId,
      sessionId: input.sessionId,
      ...(this.#now === undefined ? {} : { now: this.#now }),
      ...(this.#generateId === undefined ? {} : { generateId: this.#generateId }),
    });
    const queue = new AsyncQueue<AdapterEvent>();
    const abortController = new AbortController();
    const systemPrompt = configString(this.#context.config, 'systemPrompt');
    const onAbort = () => void this.cancel({ runId: input.runId });
    input.abortSignal?.addEventListener('abort', onAbort, { once: true });

    const queryInput: CodeBuddyQueryInput = {
      prompt: input.prompt,
      permissionMode: this.#permissionMode(input.permissionPolicy),
      settingSources: this.#settingSources(input.configScopes),
      env: this.#buildEnv(),
      abortController,
      canUseTool: this.#createPermissionHandler(queue, factory, input.permissionPolicy),
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(input.model === undefined ? {} : { model: input.model.modelId }),
      ...(input.maxTurns === undefined ? {} : { maxTurns: input.maxTurns }),
      ...(input.adapterSessionId === undefined ? {} : { resume: input.adapterSessionId }),
      ...(systemPrompt === undefined ? {} : { systemPrompt }),
      ...this.#optionalSdkConfig(),
    };

    const startedEvent = factory.create('run.started', {
      adapterId: ADAPTER_ID,
      ...(input.model === undefined ? {} : { model: input.model }),
    });
    let stream: CodeBuddyQueryStream;
    try {
      stream = this.#sdk.query(queryInput);
    } catch (error) {
      input.abortSignal?.removeEventListener('abort', onAbort);
      yield startedEvent;
      yield factory.create('run.failed', { error: this.#classifyError(errorMessage(error)) });
      return;
    }
    const active: ActiveRun = {
      runId: input.runId,
      abortController,
      stream,
      queue,
      factory,
      cancelled: false,
      cancelReason: 'Run cancelled.',
      terminal: false,
      lastActivityAt: Date.now(),
      runningTools: new Map(),
      settledTools: new Set(),
    };
    this.#active = active;
    let producerDone = false;
    const producer = this.#consume(active).finally(() => {
      producerDone = true;
    });
    if (input.abortSignal?.aborted) void this.cancel({ runId: input.runId });

    try {
      yield startedEvent;
      for await (const event of queue) yield event;
      await settleWithin(producer, this.#shutdownGraceMs);
    } finally {
      input.abortSignal?.removeEventListener('abort', onAbort);
      if (!producerDone) await this.cancel({ runId: input.runId, reason: 'Event consumer closed.' });
      await this.#stopVendor(active);
      if (this.#active === active) this.#active = undefined;
      for (const [requestId, pending] of this.#pendingInteractions) {
        this.#pendingInteractions.delete(requestId);
        pending.resolve({ behavior: 'deny', message: 'Run ended.' });
      }
    }
  }

  async #consume(active: ActiveRun): Promise<void> {
    const { stream, queue, factory, runningTools, settledTools } = active;
    const iterator = stream[Symbol.asyncIterator]();
    const startedAt = Date.now();
    let sessionInitialized = false;
    try {
      while (!active.terminal) {
        const watchdog = createWatchdog(
          active,
          startedAt,
          this.#runTimeoutMs,
          this.#idleTimeoutMs,
          this.#terminalSignalGraceMs,
          () => this.#pendingInteractions.size > 0,
        );
        const outcome = await Promise.race([
          iterator.next().then((value) => ({ kind: 'next' as const, value })),
          watchdog.promise,
        ]).finally(watchdog.cancel);
        if (outcome.kind === 'timeout') {
          this.#settleRunningTools(runningTools, settledTools, queue, factory, true);
          this.#resolvePendingInteractions(active, 'Run timed out.');
          const error =
            outcome.timeout === 'authentication' && active.pendingFailure
              ? active.pendingFailure
              : {
                  code: 'RUN_TIMEOUT' as const,
                  message:
                    outcome.timeout === 'run'
                      ? `CodeBuddy run exceeded ${this.#runTimeoutMs}ms.`
                      : `CodeBuddy stream produced no activity for ${this.#idleTimeoutMs}ms.`,
                  retryable: true,
                  adapterCode: outcome.timeout === 'run' ? 'CODEBUDDY_RUN_TIMEOUT' : 'CODEBUDDY_IDLE_TIMEOUT',
                };
          this.#emitTerminal(active, factory.create('run.failed', { error }));
          void this.#stopVendor(active);
          break;
        }
        if (outcome.value.done) break;
        active.lastActivityAt = Date.now();
        const message = asRecord(outcome.value.value);
        const type = stringValue(message.type);
        if (active.cancelled) break;
        const messageContent = asRecord(message.message).content;
        if (Array.isArray(messageContent)) {
          for (const block of messageContent.map(asRecord)) {
            if (block.type === 'tool_result') this.#settleTool(block, runningTools, settledTools, queue, factory);
          }
        }
        if (type === 'system' && message.subtype === 'init') {
          if (!sessionInitialized) {
            sessionInitialized = true;
            queue.push(
              factory.create('session.initialized', {
                ...(stringValue(message.session_id) ? { adapterSessionId: stringValue(message.session_id) } : {}),
                capabilities,
              }),
            );
          }
        } else if (type === 'stream_event') {
          const delta = asRecord(asRecord(message.event).delta);
          if (delta.type === 'text_delta' && stringValue(delta.text)) {
            queue.push(factory.create('assistant.delta', { channel: 'output', text: stringValue(delta.text) }));
          } else if (delta.type === 'thinking_delta' && stringValue(delta.thinking)) {
            queue.push(factory.create('assistant.delta', { channel: 'thinking', text: stringValue(delta.thinking) }));
          }
        } else if (type === 'assistant') {
          if (Array.isArray(messageContent)) {
            const text = messageContent
              .map(asRecord)
              .filter((block) => block.type === 'text')
              .map((block) => stringValue(block.text))
              .join('');
            const authenticationFailure = legacyAuthenticationFailure(text);
            if (authenticationFailure) {
              active.pendingFailure = this.#classifyError(authenticationFailure);
              active.pendingFailureAt = Date.now();
              continue;
            }
            if (text && !active.pendingFailure) queue.push(factory.create('assistant.message', { text }));
            for (const block of messageContent.map(asRecord)) {
              if (block.type === 'tool_use') this.#startTool(block, runningTools, settledTools, queue, factory);
            }
          }
        } else if (type === 'tool_result') {
          this.#settleTool(message, runningTools, settledTools, queue, factory);
        } else if (type === 'error') {
          this.#settleRunningTools(runningTools, settledTools, queue, factory, true);
          this.#emitTerminal(
            active,
            factory.create('run.failed', { error: this.#classifyError(stringValue(message.error)) }),
          );
        } else if (type === 'result') {
          const usage = this.#usage(message);
          if (message.is_error === true) {
            this.#settleRunningTools(runningTools, settledTools, queue, factory, true);
            const errors = Array.isArray(message.errors)
              ? message.errors.map(String).join('\n')
              : 'CodeBuddy run failed.';
            this.#emitTerminal(active, factory.create('run.failed', { error: this.#classifyError(errors) }));
          } else {
            this.#settleRunningTools(runningTools, settledTools, queue, factory, false);
            if (Object.keys(usage).length > 0) queue.push(factory.create('usage.updated', usage));
            this.#emitTerminal(active, factory.create('run.completed', Object.keys(usage).length > 0 ? { usage } : {}));
          }
        }
      }

      if (!active.terminal && !active.cancelled) {
        this.#emitTerminal(
          active,
          factory.create('run.failed', {
            error: active.pendingFailure ?? {
              code: 'HARNESS_PROTOCOL_ERROR',
              message: 'CodeBuddy stream ended without a result message.',
              retryable: false,
            },
          }),
        );
      }
    } catch (error) {
      if (!active.terminal) {
        this.#settleRunningTools(runningTools, settledTools, queue, factory, true);
        this.#emitTerminal(
          active,
          active.cancelled
            ? factory.create('run.cancelled', { reason: active.cancelReason })
            : factory.create('run.failed', { error: this.#classifyError(errorMessage(error)) }),
        );
      }
    }
  }

  #emitTerminal(active: ActiveRun, event: AdapterEvent): void {
    if (active.terminal) return;
    active.terminal = true;
    active.queue.push(event);
    active.queue.end();
  }

  #resolvePendingInteractions(active: ActiveRun, message: string): void {
    for (const [requestId, pending] of this.#pendingInteractions) {
      this.#pendingInteractions.delete(requestId);
      active.queue.push(
        active.factory.create('interaction.resolved', {
          requestId,
          outcome: 'cancelled',
        }),
      );
      pending.resolve({ behavior: 'deny', message });
    }
  }

  #stopVendor(active: ActiveRun): Promise<void> {
    active.stopPromise ??= (async () => {
      active.abortController.abort(active.cancelReason);
      const shutdownTasks: Promise<unknown>[] = [active.stream.interrupt().catch(() => undefined)];
      if (active.stream.return) {
        shutdownTasks.push(active.stream.return().catch(() => undefined));
      }
      await settleWithin(Promise.all(shutdownTasks), this.#shutdownGraceMs);
    })();
    return active.stopPromise;
  }

  #createPermissionHandler(
    queue: AsyncQueue<AdapterEvent>,
    factory: AdapterEventFactory,
    policy: AdapterRunInput['permissionPolicy'],
  ): CodeBuddyCanUseTool {
    return async (toolName, input, options) => {
      if (toolName !== 'AskUserQuestion' && policy === 'read-only') {
        return { behavior: 'deny', message: 'The read-only policy denies tool execution.' };
      }
      const requestId = options.toolUseID || `interaction:${toolName}:${this.#pendingInteractions.size + 1}`;
      let questionKeys: Record<string, string> | undefined;
      if (toolName === 'AskUserQuestion' && (!Array.isArray(input.questions) || input.questions.length === 0)) {
        return { behavior: 'deny', message: 'CodeBuddy supplied no valid questions.' };
      }
      const payload =
        toolName === 'AskUserQuestion'
          ? (() => {
              const questions = Array.isArray(input.questions) ? input.questions.map(asRecord).slice(0, 16) : [];
              questionKeys = {};
              return {
                kind: 'question' as const,
                requestId,
                questions: questions.map((question, index) => {
                  const id = `${requestId}:${index + 1}`;
                  const prompt = stringValue(question.question) || 'Additional information required.';
                  questionKeys![id] = prompt;
                  const optionsValue = Array.isArray(question.options)
                    ? question.options.map(asRecord).map((option) => ({
                        label: stringValue(option.label) || 'Option',
                        value: stringValue(option.label) || 'Option',
                      }))
                    : undefined;
                  return {
                    id,
                    prompt,
                    ...(optionsValue?.length ? { options: optionsValue } : {}),
                    ...(typeof question.multiSelect === 'boolean' ? { multiple: question.multiSelect } : {}),
                  };
                }),
              };
            })()
          : {
              kind: 'permission' as const,
              requestId,
              toolName,
              risk: isHighRiskTool(toolName) ? ('high' as const) : ('medium' as const),
              inputSummary: sanitizeJsonObject(input),
            };

      return new Promise<CodeBuddyPermissionResult>((resolve) => {
        this.#pendingInteractions.set(requestId, {
          kind: payload.kind,
          input,
          ...(questionKeys === undefined ? {} : { questionKeys }),
          resolve,
        });
        queue.push(factory.create('interaction.requested', payload));
      });
    };
  }

  #startTool(
    block: Record<string, unknown>,
    running: Map<string, string>,
    settled: Set<string>,
    queue: AsyncQueue<AdapterEvent>,
    factory: AdapterEventFactory,
  ): void {
    const id = stringValue(block.id) || `tool:${running.size + settled.size + 1}`;
    if (running.has(id) || settled.has(id)) return;
    const name = stringValue(block.name) || 'unknown';
    running.set(id, name);
    queue.push(
      factory.create('tool.started', {
        toolUseId: id,
        name,
        ...(isRecord(block.input) ? { inputSummary: sanitizeJsonObject(block.input) } : {}),
      }),
    );
  }

  #settleTool(
    block: Record<string, unknown>,
    running: Map<string, string>,
    settled: Set<string>,
    queue: AsyncQueue<AdapterEvent>,
    factory: AdapterEventFactory,
  ): void {
    const id = stringValue(block.tool_use_id) || stringValue(block.toolUseId) || [...running.keys()].at(-1);
    if (!id || settled.has(id)) return;
    if (!running.has(id)) {
      running.set(id, 'unknown');
      queue.push(factory.create('tool.started', { toolUseId: id, name: 'unknown' }));
    }
    running.delete(id);
    settled.add(id);
    const failed = block.is_error === true || block.isError === true;
    if (failed) {
      queue.push(
        factory.create('tool.failed', {
          toolUseId: id,
          error: { code: 'HARNESS_FAILED', message: 'CodeBuddy tool execution failed.', retryable: false },
        }),
      );
    } else {
      const output = jsonValue(block.content);
      queue.push(
        factory.create('tool.completed', {
          toolUseId: id,
          ...(output === undefined ? {} : { outputSummary: output }),
        }),
      );
    }
  }

  #settleRunningTools(
    running: Map<string, string>,
    settled: Set<string>,
    queue: AsyncQueue<AdapterEvent>,
    factory: AdapterEventFactory,
    failed: boolean,
  ): void {
    for (const id of [...running.keys()]) {
      this.#settleTool({ tool_use_id: id, ...(failed ? { is_error: true } : {}) }, running, settled, queue, factory);
    }
  }

  #usage(message: Record<string, unknown>): Record<string, number> {
    const sdkUsage = asRecord(message.usage);
    return compactNumbers({
      inputTokens: numberValue(sdkUsage.input_tokens),
      outputTokens: numberValue(sdkUsage.output_tokens),
      cachedInputTokens: numberValue(sdkUsage.cache_read_input_tokens),
      costUsd: numberValue(message.total_cost_usd),
      durationMs: numberValue(message.duration_ms),
      turns: numberValue(message.num_turns),
    });
  }

  #permissionMode(policy: AdapterRunInput['permissionPolicy']): 'default' | 'acceptEdits' | 'plan' {
    if (policy === 'auto-edit') return 'acceptEdits';
    if (policy === 'read-only') return 'plan';
    return 'default';
  }

  #settingSources(scopes: readonly ConfigScope[]): Array<'user' | 'project' | 'local'> {
    return scopes.filter((scope): scope is 'user' | 'project' | 'local' => scope !== 'organization');
  }

  #buildEnv(): Record<string, string> {
    const apiKey = this.#context.credentials?.CODEBUDDY_API_KEY;
    if (!apiKey) {
      throw new HarnessAdapterError({
        code: 'AUTHENTICATION_FAILED',
        message: 'Missing credential: CODEBUDDY_API_KEY',
        retryable: false,
      });
    }
    const environment = configString(this.#context.config, 'internetEnvironment') ?? 'internal';
    const env: Record<string, string> = {
      CODEBUDDY_API_KEY: apiKey,
      CODEBUDDY_INTERNET_ENVIRONMENT: environment,
      ELECTRON_RUN_AS_NODE: '1',
      SERVER__PORT: '0',
    };
    const baseUrl = configString(this.#context.config, 'baseUrl');
    if (environment !== 'internal' && baseUrl) env.CODEBUDDY_BASE_URL = baseUrl.replace(/\/+$/, '');
    return env;
  }

  #optionalSdkConfig(): { cwd?: string; pathToCodebuddyCode?: string } {
    const pathToCodebuddyCode = configString(this.#context.config, 'pathToCodebuddyCode');
    return pathToCodebuddyCode === undefined ? {} : { pathToCodebuddyCode };
  }

  #classifyError(message: string): HarnessError {
    const safe = redact(message || 'CodeBuddy run failed.', Object.values(this.#context.credentials ?? {}));
    if (/api[ _-]?key|auth|unauthori[sz]ed|\b401\b/i.test(safe)) {
      return { code: 'AUTHENTICATION_FAILED', message: safe, retryable: false };
    }
    if (/config|setting|invalid option/i.test(safe)) {
      return { code: 'CONFIGURATION_INVALID', message: safe, retryable: false };
    }
    return { code: 'HARNESS_FAILED', message: safe, retryable: true };
  }

  #assertUsable(): void {
    if (this.#disposed) throw new Error('The CodeBuddy runtime has been disposed.');
  }
}

function isHighRiskTool(name: string): boolean {
  return /(?:bash|shell|terminal|execute|write|edit|delete|remove|notebook)/i.test(name);
}

function configString(config: AdapterRuntimeContext['config'], key: string): string | undefined {
  const value = config?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function legacyAuthenticationFailure(text: string): string | undefined {
  const normalized = text.trim();
  return /^(?:error:\s*)?401\b.*(?:unauthorized|authentication required)/i.test(normalized) ? normalized : undefined;
}

function createWatchdog(
  active: ActiveRun,
  startedAt: number,
  runTimeoutMs: number,
  idleTimeoutMs: number,
  terminalSignalGraceMs: number,
  hasPendingInteraction: () => boolean,
): {
  promise: Promise<{ kind: 'timeout'; timeout: 'run' | 'idle' | 'authentication' }>;
  cancel: () => void;
} {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  let resolveTimeout: (value: { kind: 'timeout'; timeout: 'run' | 'idle' | 'authentication' }) => void = () =>
    undefined;
  const promise = new Promise<{ kind: 'timeout'; timeout: 'run' | 'idle' | 'authentication' }>((resolve) => {
    resolveTimeout = resolve;
  });
  const schedule = () => {
    if (cancelled || active.terminal) return;
    const now = Date.now();
    const runRemaining = startedAt + runTimeoutMs - now;
    if (runRemaining <= 0) {
      resolveTimeout({ kind: 'timeout', timeout: 'run' });
      return;
    }
    const authenticationRemaining =
      active.pendingFailureAt === undefined
        ? Number.POSITIVE_INFINITY
        : active.pendingFailureAt + terminalSignalGraceMs - now;
    if (authenticationRemaining <= 0) {
      resolveTimeout({ kind: 'timeout', timeout: 'authentication' });
      return;
    }
    const interactionPending = hasPendingInteraction();
    const idleRemaining = active.lastActivityAt + idleTimeoutMs - now;
    if (!interactionPending && idleRemaining <= 0) {
      resolveTimeout({ kind: 'timeout', timeout: 'idle' });
      return;
    }
    const nextCheck = interactionPending
      ? Math.min(runRemaining, authenticationRemaining, 1_000)
      : Math.min(runRemaining, idleRemaining, authenticationRemaining);
    timer = setTimeout(schedule, Math.max(1, nextCheck));
  };
  schedule();
  return {
    promise,
    cancel: () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    },
  };
}

async function settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  if (timeoutMs <= 0) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const settled = await Promise.race([promise.then(() => true), timedOut]);
  if (timer) clearTimeout(timer);
  return settled;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function compactNumbers(values: Record<string, number | undefined>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, number] => entry[1] !== undefined),
  );
}

function jsonValue(value: unknown): JsonValue | undefined {
  try {
    return value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as JsonValue);
  } catch {
    return undefined;
  }
}

function sanitizeJsonObject(value: Record<string, unknown>): Record<string, JsonValue> {
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 32)
      .flatMap(([key, item]) => {
        if (/(?:api.?key|authorization|credential|password|secret|token)/i.test(key)) {
          return [[key, '[REDACTED]']];
        }
        const normalized = jsonValue(item);
        return normalized === undefined ? [] : [[key, normalized]];
      }),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function redact(message: string, secrets: readonly string[]): string {
  return secrets
    .reduce((safe, secret) => (secret ? safe.split(secret).join('[REDACTED]') : safe), message)
    .slice(0, 2_048);
}
