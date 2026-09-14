import type { Stats } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const MAX_CREDENTIAL_BYTES = 16 * 1024;
const credentialDecoder = new TextDecoder('utf-8', { fatal: true });

export class RuntimeCredentialError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RuntimeCredentialError';
  }
}

export async function resolveRuntimeCredential(options: {
  environmentKey: string;
  fileEnvironmentKey: string;
  environment?: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
}): Promise<string | undefined> {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const environmentValue = nonEmpty(environment[options.environmentKey]);
  const configuredFile = nonEmpty(environment[options.fileEnvironmentKey]);

  if (environmentValue && configuredFile) {
    throw new RuntimeCredentialError('Configure exactly one Runtime credential source.');
  }
  if (environmentValue) return environmentValue;
  if (!configuredFile) return undefined;

  return readCredentialFile(path.resolve(configuredFile), platform);
}

async function readCredentialFile(file: string, platform: NodeJS.Platform): Promise<string> {
  try {
    const handle = await open(file, 'r');
    try {
      const opened = await handle.stat();
      assertFileMetadata(opened, platform);
      const bytes = await handle.readFile();
      if (bytes.length === 0 || bytes.length > MAX_CREDENTIAL_BYTES) {
        throw invalidFileSize();
      }
      return parseCredential(bytes);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof RuntimeCredentialError) throw error;
    throw new RuntimeCredentialError('The Runtime credential file could not be read.', { cause: error });
  }
}

function assertFileMetadata(info: Stats, platform: NodeJS.Platform): void {
  if (!info.isFile() || info.size === 0 || info.size > MAX_CREDENTIAL_BYTES) {
    throw invalidFileSize();
  }
  if (platform !== 'win32' && (info.mode & 0o077) !== 0) {
    throw new RuntimeCredentialError('The Runtime credential file permissions must be mode 0600 or stricter.');
  }
}

function invalidFileSize(): RuntimeCredentialError {
  return new RuntimeCredentialError('The Runtime credential file must be a non-empty regular file under 16 KiB.');
}

function parseCredential(bytes: Buffer): string {
  let value: string;
  try {
    value = credentialDecoder.decode(bytes);
  } catch (error) {
    throw new RuntimeCredentialError('The Runtime credential file must contain valid UTF-8 text.', {
      cause: error,
    });
  }
  if (value.endsWith('\r\n')) value = value.slice(0, -2);
  else if (value.endsWith('\n')) value = value.slice(0, -1);
  if (value.length === 0 || /[\0\r\n]/u.test(value)) {
    throw new RuntimeCredentialError('The Runtime credential file must contain exactly one non-empty line.');
  }
  return value;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.length === 0 ? undefined : value;
}
