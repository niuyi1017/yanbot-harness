import { describe, expect, it } from 'vitest';

import { LocalAuthError, LocalAuthManager } from '../src/auth.js';

describe('LocalAuthManager', () => {
  it('authenticates a bearer token without exposing it through errors', () => {
    const auth = manager();

    expect(auth.getAccessToken()).toBe('access-secret');
    expect(JSON.stringify(auth)).not.toContain('access-secret');
    expect(auth.authenticate({ authorization: 'Bearer access-secret' })).toEqual({ kind: 'bearer' });
    expect(() => auth.authenticate({ authorization: 'Bearer wrong-secret' })).toThrow(LocalAuthError);
    try {
      auth.authenticate({ authorization: 'Bearer wrong-secret' });
    } catch (error) {
      expect(String(error)).not.toContain('wrong-secret');
      expect(String(error)).not.toContain('access-secret');
    }
  });

  it('rejects browser origins even when they present the bearer token', () => {
    const auth = manager();

    expect(() =>
      auth.authenticate({ authorization: 'Bearer access-secret', origin: 'https://evil.example' }),
    ).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
    expect(auth.authenticate({ authorization: 'Bearer access-secret', origin: 'http://127.0.0.1:4173' })).toEqual({
      kind: 'bearer',
    });
  });

  it('exchanges a binding once and binds the cookie session to the exact origin', () => {
    const auth = manager();
    const binding = auth.issueBrowserBinding('http://127.0.0.1:4173');
    const session = auth.exchangeBrowserBinding(binding.token, binding.origin);

    expect(session.cookie).toContain('HttpOnly');
    expect(session.cookie).toContain('SameSite=Strict');
    expect(
      auth.authenticate({ cookie: `yanbot_harness_local=${session.cookieValue}`, origin: binding.origin }),
    ).toEqual({ kind: 'browser', origin: binding.origin });
    expect(() => auth.exchangeBrowserBinding(binding.token, binding.origin)).toThrowError(
      expect.objectContaining({ code: 'UNAUTHORIZED' }),
    );
    expect(() =>
      auth.authenticate({ cookie: `yanbot_harness_local=${session.cookieValue}`, origin: 'http://localhost:4173' }),
    ).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
  });

  it('expires access, binding, and browser session credentials', () => {
    let now = 1_000;
    const auth = manager(() => now, 2_000);
    const binding = auth.issueBrowserBinding('http://127.0.0.1:4173', 1_000);
    now = 2_000;
    expect(() => auth.exchangeBrowserBinding(binding.token, binding.origin)).toThrowError(
      expect.objectContaining({ code: 'UNAUTHORIZED' }),
    );
    now = 3_001;
    expect(() => auth.authenticate({ authorization: 'Bearer access-secret' })).toThrowError(
      expect.objectContaining({ code: 'UNAUTHORIZED' }),
    );
  });
});

function manager(now: () => number = () => 1_000, accessTokenTtlMs = 60_000): LocalAuthManager {
  let id = 0;
  return new LocalAuthManager({
    accessToken: 'access-secret',
    accessTokenTtlMs,
    allowedOrigins: ['http://127.0.0.1:4173'],
    now,
    generateId: () => `id-${++id}`,
    generateSecret: () => `secret-${id}`,
  });
}
