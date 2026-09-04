import { describe, expect, it } from 'vitest';

import { AdapterRegistry, HarnessAdapterError, assertRuntimeMatchesCapabilities } from '../src/index.js';
import type { AdapterRuntime, HarnessAdapter } from '../src/index.js';

const adapter: HarnessAdapter = {
  manifest: {
    protocolVersion: '1.0.0',
    adapterId: 'cn.yanbot.test',
    adapterVersion: '0.1.0',
    displayName: 'Test Adapter',
    harness: { name: 'Test' },
    runtimeKinds: ['in-process'],
  },
  async probe() {
    return { available: true };
  },
  async createRuntime() {
    throw new Error('Not needed by this test.');
  },
};

describe('AdapterRegistry', () => {
  it('registers and resolves a valid adapter', () => {
    const registry = new AdapterRegistry();
    registry.register(adapter);
    expect(registry.get('cn.yanbot.test')).toBe(adapter);
    expect(registry.list()).toHaveLength(1);
  });

  it('rejects duplicate adapters', () => {
    const registry = new AdapterRegistry();
    registry.register(adapter);
    expect(() => registry.register(adapter)).toThrow(HarnessAdapterError);
  });

  it('returns a stable unavailable error', () => {
    const registry = new AdapterRegistry();
    try {
      registry.get('cn.yanbot.missing');
      throw new Error('Expected lookup to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(HarnessAdapterError);
      expect((error as HarnessAdapterError).code).toBe('ADAPTER_UNAVAILABLE');
    }
  });
});

describe('assertRuntimeMatchesCapabilities', () => {
  it('rejects a method that contradicts its capability declaration', async () => {
    const runtime: AdapterRuntime = {
      async capabilities() {
        return { 'models.list': { level: 'unsupported' } };
      },
      async listModels() {
        return [];
      },
      async *startRun() {
        yield* [];
      },
      async cancel() {},
      async dispose() {},
    };

    await expect(assertRuntimeMatchesCapabilities(runtime)).rejects.toMatchObject({ code: 'ADAPTER_INCOMPATIBLE' });
  });
});
