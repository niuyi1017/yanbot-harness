import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isIP } from 'node:net';
import path from 'node:path';

import { HarnessSdkError } from './transport.js';

export type RuntimeDescriptor = {
  schemaVersion: 1;
  instanceId: string;
  pid: number;
  origin: string;
  accessToken: string;
  expiresAt: string;
};

export async function readRuntimeDescriptor(
  options: {
    descriptorPath?: string;
    environment?: Readonly<Record<string, string | undefined>>;
    now?: () => Date;
  } = {},
): Promise<RuntimeDescriptor> {
  const environment = options.environment ?? process.env;
  const file = path.resolve(
    options.descriptorPath ??
      environment.YANBOT_HARNESS_RUNTIME_DESCRIPTOR ??
      path.join(homedir(), '.yanbot-harness', 'runtime.json'),
  );
  let info;
  let raw: string;
  try {
    [info, raw] = await Promise.all([stat(file), readFile(file, 'utf8')]);
  } catch (error) {
    throw new HarnessSdkError('runtime', 'The local Runtime descriptor could not be read. Start the Runtime first.', {
      cause: error,
    });
  }
  if (!info.isFile()) throw new HarnessSdkError('runtime', 'The local Runtime descriptor is not a regular file.');
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
    throw new HarnessSdkError('authentication', 'The local Runtime descriptor permissions are too broad.');
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new HarnessSdkError('protocol', 'The local Runtime descriptor is invalid.', { cause: error });
  }
  if (!isDescriptor(value)) throw new HarnessSdkError('protocol', 'The local Runtime descriptor is invalid.');
  const expiresAt = new Date(value.expiresAt).getTime();
  if (!Number.isFinite(expiresAt) || expiresAt <= (options.now ?? (() => new Date()))().getTime()) {
    throw new HarnessSdkError('authentication', 'The local Runtime descriptor has expired.');
  }
  assertLoopbackOrigin(value.origin);
  if (!isProcessAlive(value.pid)) throw new HarnessSdkError('runtime', 'The local Runtime process is not running.');
  return value;
}

function isDescriptor(value: unknown): value is RuntimeDescriptor {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 6 &&
    record.schemaVersion === 1 &&
    typeof record.instanceId === 'string' &&
    Number.isInteger(record.pid) &&
    (record.pid as number) > 0 &&
    typeof record.origin === 'string' &&
    typeof record.accessToken === 'string' &&
    record.accessToken.length > 0 &&
    typeof record.expiresAt === 'string'
  );
}

function assertLoopbackOrigin(origin: string): void {
  let url: URL;
  try {
    url = new URL(origin);
  } catch (error) {
    throw new HarnessSdkError('protocol', 'The local Runtime descriptor origin is invalid.', { cause: error });
  }
  const hostname = url.hostname.replace(/^\[|\]$/gu, '');
  const version = isIP(hostname);
  if (
    url.protocol !== 'http:' ||
    (hostname !== 'localhost' && hostname !== '::1' && !(version === 4 && hostname.startsWith('127.')))
  ) {
    throw new HarnessSdkError('protocol', 'The local Runtime descriptor must use a loopback HTTP origin.');
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EPERM';
  }
}
