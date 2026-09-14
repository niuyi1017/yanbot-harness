import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveRuntimeCredential, RuntimeCredentialError } from '../src/runtime-credential.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('CodeBuddy Runtime credential', () => {
  it('uses the Runtime-only environment value', async () => {
    const previousValue = process.env.CODEBUDDY_API_KEY;
    await expect(resolveCredential({ environment: { CODEBUDDY_API_KEY: 'environment-secret' } })).resolves.toBe(
      'environment-secret',
    );
    expect(process.env.CODEBUDDY_API_KEY).toBe(previousValue);
  });

  it('reads one line from a protected credential file', async () => {
    const file = await credentialFile('file-secret\r\n');
    await expect(resolveCredential({ environment: { CODEBUDDY_API_KEY_FILE: file } })).resolves.toBe('file-secret');
  });

  it('rejects ambiguous credential sources without exposing either value', async () => {
    const file = await credentialFile('file-secret');
    const error = await captureError(
      resolveCredential({
        environment: { CODEBUDDY_API_KEY: 'environment-secret', CODEBUDDY_API_KEY_FILE: file },
      }),
    );
    expect(error).toBeInstanceOf(RuntimeCredentialError);
    expect(error.message).toContain('exactly one');
    expect(error.message).not.toMatch(/environment-secret|file-secret/u);
  });

  it.each([
    ['', 'non-empty regular file'],
    ['first\nsecond\n', 'exactly one non-empty line'],
    ['value\0suffix', 'exactly one non-empty line'],
  ])('rejects invalid credential file content', async (contents, message) => {
    const file = await credentialFile(contents);
    await expect(resolveCredential({ environment: { CODEBUDDY_API_KEY_FILE: file } })).rejects.toThrow(message);
  });

  it('rejects a directory instead of reading it as a credential', async () => {
    const root = await fixtureRoot();
    const directory = path.join(root, 'credential-directory');
    await mkdir(directory, { mode: 0o700 });
    await expect(resolveCredential({ environment: { CODEBUDDY_API_KEY_FILE: directory } })).rejects.toThrow(
      'non-empty regular file',
    );
  });

  it('rejects credential files at or above the documented limit', async () => {
    const file = await credentialFile('x'.repeat(16 * 1024 + 1));
    await expect(resolveCredential({ environment: { CODEBUDDY_API_KEY_FILE: file } })).rejects.toThrow('under 16 KiB');
  });

  it('does not expose a configured file path when reading fails', async () => {
    const root = await fixtureRoot();
    const file = path.join(root, 'sensitive-name.key');
    const error = await captureError(resolveCredential({ environment: { CODEBUDDY_API_KEY_FILE: file } }));
    expect(error).toBeInstanceOf(RuntimeCredentialError);
    expect(error.message).toBe('The Runtime credential file could not be read.');
    expect(error.message).not.toContain(file);
  });

  it.runIf(process.platform !== 'win32')('rejects POSIX permissions accessible by other users', async () => {
    const file = await credentialFile('file-secret');
    await chmod(file, 0o644);
    await expect(resolveCredential({ environment: { CODEBUDDY_API_KEY_FILE: file } })).rejects.toThrow(
      'mode 0600 or stricter',
    );
  });

  it('permits the Windows ACL model without applying POSIX mode bits', async () => {
    const file = await credentialFile('file-secret');
    await chmod(file, 0o644);
    await expect(resolveCredential({ environment: { CODEBUDDY_API_KEY_FILE: file }, platform: 'win32' })).resolves.toBe(
      'file-secret',
    );
  });

  it('returns undefined when neither source is configured', async () => {
    await expect(resolveCredential({ environment: {} })).resolves.toBeUndefined();
  });
});

async function credentialFile(contents: string): Promise<string> {
  const root = await fixtureRoot();
  const file = path.join(root, 'codebuddy.key');
  await writeFile(file, contents, { mode: 0o600 });
  return file;
}

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'yanbot-harness-codebuddy-credential-'));
  roots.push(root);
  return root;
}

async function captureError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
  }
  throw new Error('Expected the operation to fail.');
}

function resolveCredential(options: {
  environment: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
}): Promise<string | undefined> {
  return resolveRuntimeCredential({
    ...options,
    environmentKey: 'CODEBUDDY_API_KEY',
    fileEnvironmentKey: 'CODEBUDDY_API_KEY_FILE',
  });
}
