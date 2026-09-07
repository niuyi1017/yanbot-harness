import { describe, expect, it } from 'vitest';

import { createEnvironmentContextProvider } from '../src/adapters.js';

describe('environment adapter context provider', () => {
  it('resolves only explicitly allowlisted environment references', async () => {
    const provider = createEnvironmentContextProvider({
      allowedEnvironmentKeys: ['ALLOWED_KEY'],
      environment: { ALLOWED_KEY: 'allowed-secret', BLOCKED_KEY: 'blocked-secret' },
    });

    expect(
      await provider({
        adapterId: 'cn.yanbot.reference',
        adapterConfig: { mode: 'safe' },
        credentialRefs: {
          PRIMARY: 'env:ALLOWED_KEY',
          BLOCKED: 'env:BLOCKED_KEY',
          KEYCHAIN: 'keychain:ignored',
        },
      }),
    ).toEqual({
      config: { mode: 'safe' },
      credentials: { PRIMARY: 'allowed-secret' },
    });
  });
});
