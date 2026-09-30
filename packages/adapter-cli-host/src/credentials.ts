import { execFile } from 'node:child_process';
import { chmod, lstat, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { CliHostError } from './runner.js';

const execute = promisify(execFile);
export type CredentialDirectoryOptions = { parentDirectory?: string; signal?: AbortSignal };

/** Own a fresh private directory only for the duration of one awaited operation. */
export async function withCredentialDirectory<T>(
  files: Readonly<Record<string, string | Uint8Array>>,
  operation: (directory: string) => Promise<T>,
  options: CredentialDirectoryOptions = {},
): Promise<T> {
  const entries = Object.entries(files);
  let total = 0;
  const names = new Set<string>();
  if (entries.length > 32) invalid();
  for (const [name, content] of entries) {
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name) ||
      name.endsWith('.') ||
      /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name) ||
      names.has(name.toLowerCase())
    )
      invalid();
    names.add(name.toLowerCase());
    if (typeof content !== 'string' && !(content instanceof Uint8Array)) invalid();
    const bytes = typeof content === 'string' ? Buffer.byteLength(content) : content.byteLength;
    if (bytes > 256 * 1024) invalid();
    total += bytes;
  }
  if (total > 1024 * 1024) invalid();
  const parent = options.parentDirectory ?? tmpdir();
  if (!path.isAbsolute(parent)) invalid();
  let directory: string | undefined;
  let identity: { dev: number; ino: number } | undefined;
  try {
    checkSignal(options.signal);
    const canonicalParent = await realpath(parent);
    directory = await mkdtemp(path.join(canonicalParent, 'harness-credentials-'));
    identity = await lstat(directory);
    await protectDirectory(directory, options.signal);
    for (const [name, content] of entries) {
      checkSignal(options.signal);
      await writeFile(path.join(directory, name), content, { flag: 'wx', mode: 0o600 });
    }
    checkSignal(options.signal);
    const result = await operation(directory);
    checkSignal(options.signal);
    return result;
  } catch (error) {
    if (error instanceof CliHostError) throw error;
    throw new CliHostError('CREDENTIAL_ERROR', 'Credential directory operation failed.');
  } finally {
    if (directory !== undefined) await removeOwnedDirectory(directory, identity);
  }
}

async function removeOwnedDirectory(directory: string, identity?: { dev: number; ino: number }): Promise<void> {
  try {
    const current = await lstat(directory);
    if (!identity || !current.isDirectory() || current.dev !== identity.dev || current.ino !== identity.ino) {
      throw new Error('identity changed');
    }
    await rm(directory, { recursive: true, force: false });
  } catch {
    throw new CliHostError('CREDENTIAL_CLEANUP_FAILED', 'Credential directory cleanup could not be verified.');
  }
}

async function protectDirectory(directory: string, signal?: AbortSignal): Promise<void> {
  if (process.platform !== 'win32') {
    await chmod(directory, 0o700);
    const info = await lstat(directory);
    if (!info.isDirectory() || info.uid !== process.getuid!() || (info.mode & 0o777) !== 0o700) invalid();
    return;
  }
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !path.isAbsolute(systemRoot)) invalid();
  const script = `$ErrorActionPreference='Stop'
$p='${directory.replaceAll("'", "''")}'
$identity=[System.Security.Principal.WindowsIdentity]::GetCurrent()
$sid=$identity.User
$old=[System.IO.Directory]::GetAccessControl($p)
$owner=$old.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
if($owner -ne $sid.Value -and $owner -ne $identity.Owner.Value){throw 'Unexpected owner'}
$acl=[System.Security.AccessControl.DirectorySecurity]::new()
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true,$false)
$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
[System.IO.Directory]::SetAccessControl($p,$acl)
$actual=[System.IO.Directory]::GetAccessControl($p)
$rules=$actual.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])
if(!$actual.AreAccessRulesProtected -or $actual.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or $rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid.Value -or $rules[0].AccessControlType -ne 'Allow'){throw 'Unexpected ACL'}
`;
  await execute(
    path.join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { ...(signal ? { signal } : {}), timeout: 15_000, maxBuffer: 8192, windowsHide: true },
  );
}

function invalid(): never {
  throw new CliHostError('CREDENTIAL_ERROR', 'Invalid credential directory configuration.');
}
function checkSignal(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CliHostError('CANCELLED', 'Credential directory operation was cancelled.');
}
