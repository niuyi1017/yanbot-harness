import {
  HARNESS_PROTOCOL_VERSION,
  adapterManifestSchema,
  harnessCapabilitiesSchema,
  type AdapterEvent,
  type AdapterManifest,
  type HarnessCapabilities,
  type HarnessError,
  type HarnessErrorCode,
  type InteractionResponse,
  type JsonValue,
  type ModelDescriptor,
  type RunRequest,
} from '@yanbot-harness/contracts';

export type AdapterRuntimeContext = {
  config?: Readonly<Record<string, JsonValue>>;
  credentials?: Readonly<Record<string, string>>;
};

export type ProbeContext = AdapterRuntimeContext;

export type AdapterProbeResult = {
  available: boolean;
  harnessVersion?: string;
  diagnostics?: readonly string[];
};

export type AdapterRunInput = RunRequest & {
  abortSignal?: AbortSignal;
};

export type ListModelsInput = {
  refresh?: boolean;
};

export interface AdapterRuntime {
  capabilities(): Promise<HarnessCapabilities>;
  listModels?(input?: ListModelsInput): Promise<ModelDescriptor[]>;
  startRun(input: AdapterRunInput): AsyncIterable<AdapterEvent>;
  resumeRun?(input: AdapterRunInput & { adapterSessionId: string }): AsyncIterable<AdapterEvent>;
  respondToInteraction?(input: InteractionResponse): Promise<void>;
  cancel(input: { runId: string; reason?: string }): Promise<void>;
  dispose(): Promise<void>;
}

export interface HarnessAdapter {
  readonly manifest: AdapterManifest;
  probe(context: ProbeContext): Promise<AdapterProbeResult>;
  createRuntime(context: AdapterRuntimeContext): Promise<AdapterRuntime>;
}

export class HarnessAdapterError extends Error {
  readonly code: HarnessErrorCode;
  readonly retryable: boolean;
  readonly adapterCode?: string;

  constructor(error: HarnessError, options?: ErrorOptions) {
    super(error.message, options);
    this.name = 'HarnessAdapterError';
    this.code = error.code;
    this.retryable = error.retryable;
    if (error.adapterCode !== undefined) this.adapterCode = error.adapterCode;
  }

  toHarnessError(): HarnessError {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.adapterCode === undefined ? {} : { adapterCode: this.adapterCode }),
    };
  }
}

export function unsupportedCapability(capability: string): HarnessAdapterError {
  return new HarnessAdapterError({
    code: 'CAPABILITY_UNSUPPORTED',
    message: `The adapter does not support capability: ${capability}`,
    retryable: false,
  });
}

export async function assertRuntimeMatchesCapabilities(runtime: AdapterRuntime): Promise<HarnessCapabilities> {
  const capabilities = harnessCapabilitiesSchema.parse(await runtime.capabilities());
  const requirements: Array<[keyof AdapterRuntime, keyof HarnessCapabilities]> = [
    ['listModels', 'models.list'],
    ['resumeRun', 'sessions.resume'],
  ];

  for (const [method, capability] of requirements) {
    const level = capabilities[capability]?.level;
    const declared = level !== undefined && level !== 'unsupported';
    const implemented = typeof runtime[method] === 'function';
    if (declared !== implemented) {
      throw new HarnessAdapterError({
        code: 'ADAPTER_INCOMPATIBLE',
        message: `Adapter method ${String(method)} does not match capability ${capability}.`,
        retryable: false,
      });
    }
  }

  const permissionLevel = capabilities['interactions.permissions']?.level;
  const questionLevel = capabilities['interactions.questions']?.level;
  const interactionDeclared =
    (permissionLevel !== undefined && permissionLevel !== 'unsupported') ||
    (questionLevel !== undefined && questionLevel !== 'unsupported');
  if (interactionDeclared !== (typeof runtime.respondToInteraction === 'function')) {
    throw new HarnessAdapterError({
      code: 'ADAPTER_INCOMPATIBLE',
      message: 'Adapter interaction method does not match its declared capabilities.',
      retryable: false,
    });
  }
  return capabilities;
}

export class AdapterRegistry {
  readonly #adapters = new Map<string, HarnessAdapter>();

  register(adapter: HarnessAdapter): void {
    const manifest = adapterManifestSchema.parse(adapter.manifest);
    if (manifest.protocolVersion !== HARNESS_PROTOCOL_VERSION) {
      throw new HarnessAdapterError({
        code: 'ADAPTER_INCOMPATIBLE',
        message: `Adapter ${manifest.adapterId} uses unsupported protocol ${manifest.protocolVersion}.`,
        retryable: false,
      });
    }
    if (this.#adapters.has(manifest.adapterId)) {
      throw new HarnessAdapterError({
        code: 'ADAPTER_INCOMPATIBLE',
        message: `Adapter ${manifest.adapterId} is already registered.`,
        retryable: false,
      });
    }
    this.#adapters.set(manifest.adapterId, adapter);
  }

  get(adapterId: string): HarnessAdapter {
    const adapter = this.#adapters.get(adapterId);
    if (!adapter) {
      throw new HarnessAdapterError({
        code: 'ADAPTER_UNAVAILABLE',
        message: `Adapter ${adapterId} is not registered.`,
        retryable: false,
      });
    }
    return adapter;
  }

  list(): readonly AdapterManifest[] {
    return [...this.#adapters.values()].map((adapter) => adapter.manifest);
  }
}
