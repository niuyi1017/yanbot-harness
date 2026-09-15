import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export async function privateDirectory(directory, signal) {
  const absolute = path.resolve(directory);
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
$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=Get-Acl -LiteralPath $p
if($acl.Owner -ne $sid.Translate([System.Security.Principal.NTAccount]).Value -and $acl.Owner -ne $sid.Value){throw 'Unexpected directory owner'}
$new=New-Object System.Security.AccessControl.DirectorySecurity
$new.SetOwner($sid)
$new.SetAccessRuleProtection($true,$false)
$rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
$new.AddAccessRule($rule)
Set-Acl -LiteralPath $p -AclObject $new
$actual=Get-Acl -LiteralPath $p
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
      { timeout: 5000, signal, windowsHide: true, maxBuffer: 8192 },
    );
  }
  return realpath(absolute);
}
