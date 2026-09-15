import { execFile } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { lstat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { HarnessSdkError } from './transport.js';

const execute = promisify(execFile);

export async function verifyManagedDescriptor(file: string, signal: AbortSignal): Promise<void> {
  try {
    signal.throwIfAborted();
    const info = await lstat(file);
    if (!info.isFile() || info.size > 65536) throw new Error('invalid descriptor file');
    if (process.platform !== 'win32') {
      if (info.uid !== process.getuid!() || (info.mode & 0o077) !== 0) throw new Error('insecure descriptor');
      return;
    }
    const systemRoot = process.env.SystemRoot;
    if (!systemRoot || !path.isAbsolute(systemRoot)) throw new Error('SystemRoot missing');
    const script = `$ErrorActionPreference='Stop'
$identity=[System.Security.Principal.WindowsIdentity]::GetCurrent()
$sid=$identity.User
$acl=[System.IO.File]::GetAccessControl('${path.resolve(file).replaceAll("'", "''")}')
$owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
if($owner -ne $sid.Value -and $owner -ne $identity.Owner.Value){throw 'Unexpected descriptor owner'}
$rules=$acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])
if($rules.Count -lt 1){throw 'Missing descriptor ACL'}
foreach($rule in $rules){if($rule.IdentityReference.Value -ne $sid.Value -or $rule.AccessControlType -ne 'Allow'){throw 'Unexpected descriptor ACL'}}
`;
    await execute(
      path.join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      { signal, timeout: 15000, windowsHide: true, maxBuffer: 8192 },
    );
  } catch {
    if (signal.aborted) throw signal.reason;
    throw new HarnessSdkError(
      'authentication',
      'The managed descriptor must be a bounded regular file accessible only to its current owner.',
    );
  }
}

export async function protectManagedState(directory: string, signal: AbortSignal): Promise<void> {
  const absolute = path.resolve(directory);
  if (
    [
      path.parse(absolute).root,
      homedir(),
      process.env.LOCALAPPDATA,
      process.env.APPDATA,
      process.env.TEMP,
      process.env.TMP,
    ]
      .filter(Boolean)
      .some((reserved) => path.resolve(reserved!) === absolute)
  ) {
    throw new HarnessSdkError('request', 'A dedicated managed state directory is required.');
  }
  try {
    for (let current = absolute; current !== path.dirname(current); current = path.dirname(current)) {
      signal.throwIfAborted();
      const info = await lstat(current);
      const systemAlias =
        process.platform === 'darwin' &&
        ['/var', '/tmp'].includes(current) &&
        info.uid === 0 &&
        (await realpath(current)) === '/private' + current;
      if (!info.isDirectory() && !systemAlias) throw new Error('linked state ancestry');
    }
    const info = await lstat(absolute);
    if (process.platform !== 'win32') {
      if (info.uid !== process.getuid!() || (info.mode & 0o077) !== 0) throw new Error('insecure state mode');
      return;
    }
    const systemRoot = process.env.SystemRoot;
    if (!systemRoot || !path.isAbsolute(systemRoot)) throw new Error('SystemRoot missing');
    const file = absolute.replaceAll("'", "''");
    const script = `$ErrorActionPreference='Stop'
$p='${file}'
$identity=[System.Security.Principal.WindowsIdentity]::GetCurrent()
$sid=$identity.User
$acl=[System.IO.Directory]::GetAccessControl($p)
$owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
if($owner -ne $sid.Value -and $owner -ne $identity.Owner.Value){throw 'Unexpected directory owner'}
$new=[System.Security.AccessControl.DirectorySecurity]::new()
$new.SetOwner($sid)
$new.SetAccessRuleProtection($true,$false)
$rule=[System.Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
$new.AddAccessRule($rule)
[System.IO.Directory]::SetAccessControl($p,$new)
$actual=[System.IO.Directory]::GetAccessControl($p)
if($actual.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){throw 'Owner normalization failed'}
$rules=$actual.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])
if(!$actual.AreAccessRulesProtected -or $rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid.Value -or $rules[0].AccessControlType -ne 'Allow'){throw 'Unexpected ACL'}
`;
    await execute(
      path.join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      { timeout: 15000, signal, windowsHide: true, maxBuffer: 8192 },
    );
  } catch {
    if (signal.aborted) throw signal.reason;
    throw new HarnessSdkError(
      'runtime',
      'The new managed state directory must be privately owned, unlinked and protected by the current user ACL.',
    );
  }
}
