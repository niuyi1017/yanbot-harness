import { expect, it } from 'vitest';
import { HarnessClient as SdkClient } from '@yanbot-harness/sdk';
import { HarnessClient, localRuntimeEnvironment, startManagedRuntime } from '../src/index.js';

it('re-exports the same client without starting any Runtime', () => {
  expect(HarnessClient).toBe(SdkClient);
});
it('uses a fixed minimum environment and excludes credentials and loader injection', () => {
  expect(
    localRuntimeEnvironment({
      PATH: '/fixture',
      CODEBUDDY_API_KEY_FILE: '/protected/file',
      NODE_OPTIONS: '--require=evil',
      NODE_PATH: '/evil',
      NPM_TOKEN: 'fixture',
      NODE_AUTH_TOKEN: 'fixture',
      CODEBUDDY_API_KEY: 'fixture',
      DYLD_INSERT_LIBRARIES: 'evil',
    }),
  ).toEqual({ PATH: '/fixture', CODEBUDDY_API_KEY_FILE: '/protected/file' });
});
it('explicit path failure never falls back to the local resolver', async () => {
  let called = false;
  await expect(
    startManagedRuntime({
      executablePath: '/missing-explicit-runtime',
      runtimeResolver: async () => {
        called = true;
        throw new Error('must not run');
      },
    }),
  ).rejects.toMatchObject({ kind: 'runtime' });
  expect(called).toBe(false);
});
