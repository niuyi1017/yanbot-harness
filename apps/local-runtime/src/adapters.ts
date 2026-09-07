import type { AdapterRuntimeContext, HarnessAdapter, ListModelsInput } from '@yanbot-harness/adapter-api';
import { AdapterRegistry, HarnessAdapterError, assertRuntimeMatchesCapabilities } from '@yanbot-harness/adapter-api';
import type {
  AdapterManifest,
  HarnessCapabilities,
  JsonValue,
  ModelDescriptor,
  RunRequest,
} from '@yanbot-harness/contracts';
import { createManagedAdapterRun, type ManagedRunController } from '@yanbot-harness/core';

export type AdapterContextProviderInput = {
  adapterId: string;
  adapterConfig: Readonly<Record<string, JsonValue>>;
  credentialRefs: Readonly<Record<string, string>>;
};

export type AdapterContextProvider = (
  input: AdapterContextProviderInput,
) => AdapterRuntimeContext | Promise<AdapterRuntimeContext>;

export type LocalAdapterServiceOptions = {
  adapters: readonly HarnessAdapter[];
  contextProvider?: AdapterContextProvider;
};

export type LocalAdapterDescriptor = {
  manifest: AdapterManifest;
  capabilities: HarnessCapabilities;
};

export function createEnvironmentContextProvider(options: {
  allowedEnvironmentKeys: readonly string[];
  environment?: Readonly<Record<string, string | undefined>>;
}): AdapterContextProvider {
  const allowed = new Set(options.allowedEnvironmentKeys);
  const environment = options.environment ?? process.env;
  return ({ adapterConfig, credentialRefs }) => {
    const credentials: Record<string, string> = {};
    for (const [credentialKey, reference] of Object.entries(credentialRefs)) {
      if (!reference.startsWith('env:')) continue;
      const environmentKey = reference.slice(4);
      if (!allowed.has(environmentKey)) continue;
      const value = environment[environmentKey];
      if (value) credentials[credentialKey] = value;
    }
    return { config: adapterConfig, credentials };
  };
}

export type AdapterConfiguration = {
  adapterConfig: Readonly<Record<string, JsonValue>>;
  credentialRefs: Readonly<Record<string, string>>;
};

const emptyConfiguration: AdapterConfiguration = { adapterConfig: {}, credentialRefs: {} };

export class LocalAdapterService {
  readonly #registry = new AdapterRegistry();
  readonly #contextProvider: AdapterContextProvider;

  constructor(options: LocalAdapterServiceOptions) {
    for (const adapter of options.adapters) this.#registry.register(adapter);
    this.#contextProvider = options.contextProvider ?? ((input) => ({ config: input.adapterConfig }));
  }

  manifest(adapterId: string): AdapterManifest {
    return this.#registry.get(adapterId).manifest;
  }

  async list(configuration: AdapterConfiguration = emptyConfiguration): Promise<LocalAdapterDescriptor[]> {
    return Promise.all(
      this.#registry.list().map(async (manifest) => ({
        manifest,
        capabilities: await this.capabilities(manifest.adapterId, configuration),
      })),
    );
  }

  async capabilities(
    adapterId: string,
    configuration: AdapterConfiguration = emptyConfiguration,
  ): Promise<HarnessCapabilities> {
    return this.#withRuntime(adapterId, configuration, (runtime) => assertRuntimeMatchesCapabilities(runtime));
  }

  async listModels(
    adapterId: string,
    configuration: AdapterConfiguration = emptyConfiguration,
    input?: ListModelsInput,
  ): Promise<ModelDescriptor[]> {
    return this.#withRuntime(adapterId, configuration, async (runtime) => {
      const capabilities = await assertRuntimeMatchesCapabilities(runtime);
      if (capabilities['models.list']?.level === 'unsupported' || !runtime.listModels) {
        throw unsupported(`Adapter ${adapterId} does not support model discovery.`);
      }
      return runtime.listModels(input);
    });
  }

  async startRun(
    adapterId: string,
    request: RunRequest,
    configuration: AdapterConfiguration,
  ): Promise<ManagedRunController> {
    const adapter = this.#registry.get(adapterId);
    if (request.model && request.model.adapterId !== adapterId) {
      throw new HarnessAdapterError({
        code: 'CONFIGURATION_INVALID',
        message: 'The selected model belongs to a different adapter.',
        retryable: false,
      });
    }
    const context = await this.#contextProvider({
      adapterId: adapter.manifest.adapterId,
      adapterConfig: configuration.adapterConfig,
      credentialRefs: configuration.credentialRefs,
    });
    return createManagedAdapterRun(adapter, context, request);
  }

  async #withRuntime<T>(
    adapterId: string,
    configuration: AdapterConfiguration,
    operation: (runtime: Awaited<ReturnType<HarnessAdapter['createRuntime']>>) => Promise<T>,
  ): Promise<T> {
    const context = await this.#contextProvider({ adapterId, ...configuration });
    const runtime = await this.#registry.get(adapterId).createRuntime(context);
    try {
      return await operation(runtime);
    } finally {
      await runtime.dispose();
    }
  }
}

function unsupported(message: string): HarnessAdapterError {
  return new HarnessAdapterError({ code: 'CAPABILITY_UNSUPPORTED', message, retryable: false });
}
