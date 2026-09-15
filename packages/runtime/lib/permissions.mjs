import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export async function privateDirectory(directory, signal) {
  const absolute = path.resolve(directory);
  assert(
    ![
      path.parse(absolute).root,
      homedir(),
      process.env.LOCALAPPDATA,
      process.env.APPDATA,
      process.env.TEMP,
      process.env.TMP,
    ]
      .filter(Boolean)
      .some((value) => path.resolve(value) === absolute),
    'A dedicated cache directory is required.',
  );
  const chain = [];
  for (let current = absolute; current !== path.dirname(current); current = path.dirname(current))
    chain.unshift(current);
  for (const current of chain) {
    signal?.throwIfAborted();
    try {
      const info = await lstat(current);
      const systemAlias =
        process.platform === 'darwin' &&
        ['/var', '/tmp'].includes(current) &&
        info.uid === 0 &&
        (await realpath(current)) === '/private' + current;
      assert(info.isDirectory() || systemAlias, 'Directory ancestry contains a link or special file.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (creation) {
        if (creation.code !== 'EEXIST' || !(await lstat(current)).isDirectory()) throw creation;
      }
    }
  }
  if (process.platform !== 'win32') {
    const info = await lstat(absolute);
    assert(
      info.uid === process.getuid() && (info.mode & 0o077) === 0,
      'Cache directory must be private (0700) and owned by this user.',
    );
  } else {
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
if(!$actual.AreAccessRulesProtected){throw 'Unprotected ACL'}
$rules=$actual.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])
if($rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid.Value -or $rules[0].AccessControlType -ne 'Allow'){throw 'Unexpected ACL'}
`;
    // No shell, no environment-selected executable, and no user text interpolated as code without escaping.
    const systemRoot = process.env.SystemRoot;
    assert(systemRoot && path.isAbsolute(systemRoot), 'Windows SystemRoot missing.');
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
  }
  return realpath(absolute);
}
