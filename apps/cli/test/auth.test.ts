import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readdir, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { RemoteCredentials, authOrigin } from '../src/auth.js';
import { runCli } from '../src/index.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const origin = 'https://cloud.example.test';
function tokens(expired = false) {
  return {
    accessToken: `yha_${'a'.repeat(43)}`,
    refreshToken: `yhr_${randomUUID()}.${'b'.repeat(43)}`,
    accessExpiresAt: new Date(Date.now() + (expired ? -1000 : 60_000)).toISOString(),
    refreshExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
  };
}
async function setup(fetchImplementation: typeof fetch) {
  const root = await mkdtemp(path.join(tmpdir(), 'harness-cli-auth-'));
  roots.push(root);
  const environment = { YANBOT_HARNESS_CREDENTIALS_DIRECTORY: path.join(root, 'credentials') };
  return { root, environment, credentials: new RemoteCredentials(origin, environment, fetchImplementation) };
}

describe('Remote CLI credentials', () => {
  it('serializes concurrent refresh and rereads the rotated family without leaking device secrets', async () => {
    let refreshes = 0;
    const { credentials, environment } = await setup(async (input, init) => {
      expect(init?.redirect).toBe('error');
      if (String(input).endsWith('/refresh')) {
        refreshes++;
        return Response.json(tokens());
      }
      return Response.json(tokens(true));
    });
    await credentials.login(randomUUID(), randomUUID(), 'private-device-secret');
    await Promise.all(Array.from({ length: 4 }, () => credentials.token()));
    expect(refreshes).toBe(1);
    const files = await readdir(environment.YANBOT_HARNESS_CREDENTIALS_DIRECTORY);
    expect(files).toHaveLength(1);
    expect(
      await readFile(path.join(environment.YANBOT_HARNESS_CREDENTIALS_DIRECTORY, files[0]!), 'utf8'),
    ).not.toContain('private-device-secret');
    expect((await credentials.status()).loggedIn).toBe(true);
  });

  it('keeps the local family when logout cannot reach the server and deletes after revocation', async () => {
    let offline = true;
    const { credentials } = await setup(async (input) => {
      if (String(input).endsWith('/logout')) {
        if (offline) throw new Error('private remote response');
        return Response.json({ loggedOut: true });
      }
      return Response.json(tokens());
    });
    await credentials.login(randomUUID(), randomUUID(), 'secret');
    await expect(credentials.logout()).rejects.toThrow('Remote authentication request failed.');
    expect((await credentials.status()).loggedIn).toBe(true);
    offline = false;
    await credentials.logout();
    expect((await credentials.status()).loggedIn).toBe(false);
  });

  it('isolates origins and rejects unsafe storage and symlinks', async () => {
    const { credentials, environment, root } = await setup(async () => Response.json(tokens()));
    await credentials.login(randomUUID(), randomUUID(), 'secret');
    expect((await new RemoteCredentials('https://other.example.test', environment).status()).loggedIn).toBe(false);
    if (process.platform !== 'win32') {
      await chmod(environment.YANBOT_HARNESS_CREDENTIALS_DIRECTORY, 0o755);
      await expect(credentials.token()).rejects.toThrow('0700');
      await chmod(environment.YANBOT_HARNESS_CREDENTIALS_DIRECTORY, 0o700);
    }
    const link = path.join(root, 'linked');
    await symlink(environment.YANBOT_HARNESS_CREDENTIALS_DIRECTORY, link, 'junction');
    await expect(
      new RemoteCredentials(origin, { YANBOT_HARNESS_CREDENTIALS_DIRECTORY: link }).status(),
    ).rejects.toThrow('Unsafe');
  });

  it('rejects insecure origins, injected URL components, oversized responses and raw server errors', async () => {
    for (const value of [
      'http://remote.example.test',
      'https://user:secret@example.test',
      'https://example.test/path',
      'https://example.test?key=secret',
    ])
      expect(() => authOrigin(value)).toThrow();
    expect(authOrigin('http://127.0.0.1:3878')).toBe('http://127.0.0.1:3878');
    const { credentials } = await setup(async () => new Response('secret'.repeat(2000)));
    await expect(credentials.login(randomUUID(), randomUUID(), 'secret')).rejects.toThrow(
      'Invalid authentication response.',
    );
    const failed = await setup(async () => new Response('do-not-print', { status: 401 }));
    await expect(failed.credentials.login(randomUUID(), randomUUID(), 'secret')).rejects.toThrow('HTTP 401');
  });

  it('runs login/status/logout without printing tokens and rejects secret command arguments', async () => {
    const { environment } = await setup(async () => Response.json(tokens()));
    let output = '';
    const io = {
      stdin: new PassThrough(),
      stdout: {
        write(chunk: unknown) {
          output += String(chunk);
          return true;
        },
      },
      stderr: {
        write(chunk: unknown) {
          output += String(chunk);
          return true;
        },
      },
    };
    const options = {
      io,
      environment: { ...environment, YANBOT_HARNESS_DEVICE_SECRET: 'device-secret' },
      fetch: async (input: string | URL | Request) =>
        Response.json(String(input).endsWith('/logout') ? { loggedOut: true } : tokens()),
    };
    expect(
      await runCli(['login', '--remote', origin, '--organization', randomUUID(), '--device', randomUUID()], options),
    ).toBe(0);
    expect(await runCli(['auth-status', '--remote', origin, '--json'], options)).toBe(0);
    expect(output).toContain('loggedIn');
    expect(output).not.toMatch(/yha_|yhr_|device-secret/u);
    expect(await runCli(['logout', '--remote', origin], options)).toBe(0);
    expect(await runCli(['login', '--remote', origin, '--secret', 'secret'], options)).toBe(2);
  });
});
