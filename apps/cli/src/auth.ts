import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { isIP } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { createInterface } from 'node:readline/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

import { HarnessSdkError } from '@yanbot-harness/sdk';
import type { CliIo } from './output.js';

const execute = promisify(execFile);
type TokenPair = { accessToken: string; accessExpiresAt: string; refreshToken: string; refreshExpiresAt: string };
type CredentialRecord = TokenPair & { origin: string; schemaVersion: 1 };

export function authOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw failure('Invalid Remote origin.');
  }
  const host = url.hostname.replace(/^\[|\]$/gu, '');
  const loopback = host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.startsWith('127.'));
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw failure('Remote login requires an HTTPS origin (HTTP is allowed only on loopback).');
  }
  return url.origin;
}

/** A serialized, origin-bound rotating credential family. Never writes device secrets. */
export class RemoteCredentials {
  readonly origin: string;
  readonly #directory: string;
  readonly #file: string;
  readonly #fetch: typeof fetch;
  constructor(origin: string, environment: Readonly<Record<string, string | undefined>>, fetchImplementation = fetch) {
    this.origin = authOrigin(origin);
    this.#directory = path.resolve(
      environment.YANBOT_HARNESS_CREDENTIALS_DIRECTORY ?? path.join(homedir(), '.yanbot-harness', 'credentials'),
    );
    this.#file = path.join(this.#directory, `${createHash('sha256').update(this.origin).digest('hex')}.json`);
    this.#fetch = fetchImplementation;
  }

  async login(organizationId: string, deviceId: string, deviceSecret: string): Promise<void> {
    if (
      ![organizationId, deviceId].every((id) =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(id),
      ) ||
      !deviceSecret ||
      deviceSecret.length > 256
    )
      throw failure('Invalid device login input.');
    await this.#locked(async () => {
      if (await this.#read()) throw failure('Already logged in to this origin; log out before replacing the identity.');
      const tokens = parseTokens(await this.#request('device/exchange', { organizationId, deviceId, deviceSecret }));
      await this.#write(tokens);
    });
  }

  async token(): Promise<{ accessToken: string; expiresAt: string }> {
    return this.#locked(async () => {
      let record = await this.#read();
      if (!record) throw failure('No saved Remote login. Use login or provide an access-token environment variable.');
      if (Date.parse(record.accessExpiresAt) <= Date.now() + 30_000) {
        if (Date.parse(record.refreshExpiresAt) <= Date.now())
          throw failure('Remote login expired. Log out and log in again.');
        const tokens = parseTokens(await this.#request('refresh', { refreshToken: record.refreshToken }));
        await this.#write(tokens);
        record = { ...tokens, origin: this.origin, schemaVersion: 1 };
      }
      return { accessToken: record.accessToken, expiresAt: record.accessExpiresAt };
    });
  }

  async status(): Promise<{ origin: string; loggedIn: boolean; refreshExpiresAt?: string }> {
    return this.#locked(async () => {
      const record = await this.#read();
      return {
        origin: this.origin,
        loggedIn: Boolean(record && Date.parse(record.refreshExpiresAt) > Date.now()),
        ...(record ? { refreshExpiresAt: record.refreshExpiresAt } : {}),
      };
    });
  }

  async logout(): Promise<void> {
    await this.#locked(async () => {
      const record = await this.#read();
      if (!record) return;
      await this.#request('logout', { refreshToken: record.refreshToken });
      await unlink(this.#file);
    });
  }

  async #request(route: string, body: unknown): Promise<unknown> {
    try {
      const response = await this.#fetch(`${this.origin}/v1/auth/${route}`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw failure(`Remote authentication failed (HTTP ${response.status}).`);
      }
      if (!response.body) throw failure('Empty authentication response.');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 8192) throw failure('Invalid authentication response.');
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch (error) {
      if (error instanceof HarnessSdkError) throw error;
      throw failure('Remote authentication request failed.');
    }
  }

  async #locked<T>(operation: () => Promise<T>): Promise<T> {
    const created = await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    if (created && process.platform === 'win32') await protectNewWindowsDirectory(this.#directory);
    await verifyPrivate(this.#directory, true);
    const lock = `${this.#file}.lock`;
    const deadline = Date.now() + 20_000;
    let handle;
    while (!handle) {
      try {
        handle = await open(lock, 'wx', 0o600);
      } catch (error) {
        if (!hasCode(error, 'EEXIST')) throw failure('Unable to lock Remote credentials.');
        if (Date.now() >= deadline)
          throw failure(
            'Remote credentials are locked by another process. A stale lock requires manual removal after verifying that process has stopped.',
          );
        await delay(50);
      }
    }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      return await operation();
    } finally {
      await handle.close();
      await unlink(lock);
    }
  }

  async #read(): Promise<CredentialRecord | undefined> {
    try {
      await verifyPrivate(this.#file, false);
      const handle = await open(this.#file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const stat = await handle.stat();
        if (
          !stat.isFile() ||
          stat.size > 8192 ||
          (process.platform !== 'win32' && (stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0))
        )
          throw failure('Unsafe Remote credential file.');
        const record: unknown = JSON.parse(await handle.readFile('utf8'));
        if (
          !record ||
          typeof record !== 'object' ||
          !('origin' in record) ||
          record.origin !== this.origin ||
          !('schemaVersion' in record) ||
          record.schemaVersion !== 1
        )
          throw failure('Invalid Remote credential record.');
        return { ...parseTokens(record, true), origin: this.origin, schemaVersion: 1 };
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return undefined;
      if (error instanceof HarnessSdkError) throw error;
      throw failure('Unable to read protected Remote credentials.');
    }
  }

  async #write(tokens: TokenPair): Promise<void> {
    const temporary = `${this.#file}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await verifyPrivate(temporary, false);
      await handle.writeFile(JSON.stringify({ schemaVersion: 1, origin: this.origin, ...tokens }));
      await handle.sync();
      await handle.close();
      await rename(temporary, this.#file);
    } finally {
      await handle.close();
      await unlink(temporary).catch((error: unknown) => {
        if (!hasCode(error, 'ENOENT')) throw error;
      });
    }
  }
}

function parseTokens(value: unknown, stored = false): TokenPair {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('Invalid authentication response.');
  const record = value as Record<string, unknown>;
  const fields = ['accessToken', 'refreshToken', 'accessExpiresAt', 'refreshExpiresAt'];
  if (Object.keys(record).some((key) => ![...fields, ...(stored ? ['origin', 'schemaVersion'] : [])].includes(key)))
    throw failure('Invalid authentication response.');
  for (const key of fields)
    if (typeof record[key] !== 'string' || record[key].length > 512) throw failure('Invalid authentication response.');
  if (
    !/^yha_[A-Za-z0-9_-]{43}$/u.test(record.accessToken as string) ||
    !/^yhr_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/u.test(record.refreshToken as string) ||
    !Number.isFinite(Date.parse(record.accessExpiresAt as string)) ||
    !Number.isFinite(Date.parse(record.refreshExpiresAt as string))
  )
    throw failure('Invalid authentication response.');
  return record as TokenPair;
}

async function protectNewWindowsDirectory(directory: string): Promise<void> {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !path.isAbsolute(systemRoot)) throw failure('Windows credential ACL protection is unavailable.');
  const script = `$ErrorActionPreference='Stop'
$p='${directory.replaceAll("'", "''")}'
$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=[System.Security.AccessControl.DirectorySecurity]::new()
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true,$false)
$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
[System.IO.Directory]::SetAccessControl($p,$acl)
`;
  try {
    await execute(
      path.join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      { timeout: 15_000, maxBuffer: 8192, windowsHide: true },
    );
  } catch {
    throw failure('Unable to protect Windows credential directory.');
  }
}

async function verifyPrivate(file: string, directory: boolean): Promise<void> {
  const stat = await lstat(file);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()))
    throw failure('Unsafe Remote credential storage.');
  if (process.platform !== 'win32') {
    if (stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0)
      throw failure(
        'Remote credential storage must be owned by this user with directory mode 0700 and file mode 0600.',
      );
    return;
  }
  // Check existing ACLs; never silently change the permissions of an existing directory.
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !path.isAbsolute(systemRoot)) throw failure('Windows credential ACL verification is unavailable.');
  const script = `$ErrorActionPreference='Stop'
$p='${file.replaceAll("'", "''")}'
$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$a=Get-Acl -LiteralPath $p
if($a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid){throw 'owner'}
foreach($r in $a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])){if($r.AccessControlType -eq 'Allow' -and $r.IdentityReference.Value -ne $sid -and $r.IdentityReference.Value -ne 'S-1-5-18'){throw 'acl'}}
`;
  try {
    await execute(
      path.join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      { timeout: 15_000, maxBuffer: 8192, windowsHide: true },
    );
  } catch {
    throw failure('Remote credential directory requires a private current-user Windows ACL.');
  }
}

export async function promptDeviceSecret(io: CliIo): Promise<string> {
  if (!io.stdin.isTTY) throw failure('Login requires an interactive terminal or YANBOT_HARNESS_DEVICE_SECRET.');
  // readline handles raw terminal input; its echo is deliberately discarded.
  const muted = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const readline = createInterface({ input: io.stdin, output: muted, terminal: true });
  io.stderr.write('Device secret: ');
  const controller = new AbortController();
  const interrupted = () => controller.abort();
  readline.once('SIGINT', interrupted);
  try {
    return await readline.question('', { signal: controller.signal });
  } finally {
    readline.close();
    muted.destroy();
    io.stderr.write('\n');
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === code;
}
function failure(message: string): HarnessSdkError {
  return new HarnessSdkError('authentication', message);
}
