import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { release } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export async function linuxOfflineNetworkGate({ kit, prefix, environment }) {
  assert.equal(process.platform, 'linux');
  assert.equal(
    process.env.GITHUB_ACTIONS,
    'true',
    'Privileged namespace creation is limited to the disposable CI runner.',
  );
  const result = await execute(
    '/usr/bin/sudo',
    [
      '-n',
      '/usr/bin/unshare',
      '--net',
      '--mount',
      '--',
      process.execPath,
      path.join(import.meta.dirname, 'linux-offline-network-child.mjs'),
      String(process.getuid()),
      String(process.getgid()),
      path.join(kit.directory, 'install-local.mjs'),
      prefix,
      kit.externalTestTrust,
      JSON.stringify(environment),
    ],
    { timeout: 200000, maxBuffer: 8192 },
  );
  return JSON.parse(result.stdout);
}

// Per-process policy, inherited by npm and Runtime. Never changes the host firewall.
export async function macOfflineNetworkGate({ kit, prefix, environment }) {
  assert.equal(process.platform, 'darwin');
  const profile =
    '(version 1)(allow default)(deny network*)(allow network-outbound (remote ip "localhost:*"))(allow network-inbound (local ip "localhost:*"))' +
    '(allow network* (local unix-socket (regex #"^/private/tmp/hvm-[A-F0-9-]+/http[.]sock$")) (remote unix-socket (regex #"^/private/tmp/hvm-[A-F0-9-]+/http[.]sock$")))';
  const base = ['-p', profile, process.execPath];
  const options = { env: environment, timeout: 180000, maxBuffer: 8192 };
  const probe = await execute(
    '/usr/bin/sandbox-exec',
    [
      ...base,
      '--input-type=module',
      '-e',
      `
    import net from 'node:net';
    import assert from 'node:assert/strict';
    const socket=net.connect({host:'192.0.2.1',port:443});
    socket.setTimeout(2000,()=>{socket.destroy();process.exitCode=1;});
    socket.on('connect',()=>{socket.destroy();process.exitCode=1;});
    socket.on('error',error=>{assert.equal(error.code,'EPERM');console.log(JSON.stringify({externalConnect:error.code}));});
  `,
    ],
    options,
  );
  assert.equal(JSON.parse(probe.stdout).externalConnect, 'EPERM');
  const result = await execute(
    '/usr/bin/sandbox-exec',
    [
      ...base,
      path.join(kit.directory, 'install-local.mjs'),
      '--prefix',
      prefix,
      '--trusted-key-file',
      kit.externalTestTrust,
    ],
    options,
  );
  const installation = JSON.parse(result.stdout);
  assert.equal(installation.reference.terminal, 'run.completed');
  return {
    status: 'passed',
    platform: 'darwin',
    kernel: release(),
    externalConnect: 'EPERM',
    loopbackAllowed: true,
    installation,
  };
}

function powershellScript(name, program, operation) {
  assert.match(name, /^YanbotHarnessOffline-[0-9]+-[0-9a-f-]{36}$/u);
  const quote = (value) => `'${value.replaceAll("'", "''")}'`;
  const identity = `$name=${quote(name)};$program=${quote(program)};`;
  if (operation === 'create')
    return (
      `$ErrorActionPreference='Stop';${identity}` +
      `if(Get-NetFirewallRule -Name $name -ErrorAction SilentlyContinue){throw 'Rule already exists'}` +
      `;$created=$false;try{New-NetFirewallRule -PolicyStore ActiveStore -Name $name -DisplayName $name -Direction Outbound ` +
      `-Action Block -Enabled True -Profile Any -Program $program -RemoteAddress Internet | Out-Null` +
      `;$created=$true` +
      `;$rule=Get-NetFirewallRule -PolicyStore ActiveStore -Name $name -ErrorAction Stop` +
      `;$filter=$rule | Get-NetFirewallApplicationFilter` +
      `;$address=$rule | Get-NetFirewallAddressFilter` +
      `;if($rule.Direction -ne 'Outbound' -or $rule.Action -ne 'Block' -or $rule.Enabled -ne 'True' ` +
      `-or $filter.Program -ne $program -or $address.RemoteAddress -notcontains 'Internet'){throw 'Rule mismatch'}` +
      `;[Console]::Out.Write('{"status":"created"}')` +
      `}catch{if($created){Get-NetFirewallRule -PolicyStore ActiveStore -Name $name -ErrorAction SilentlyContinue | ` +
      `Where-Object {($_ | Get-NetFirewallApplicationFilter).Program -eq $program} | Remove-NetFirewallRule};throw}`
    );
  if (operation === 'remove')
    return (
      `$ErrorActionPreference='Stop';${identity}` +
      `$rule=Get-NetFirewallRule -PolicyStore ActiveStore -Name $name -ErrorAction SilentlyContinue` +
      `;if($rule){$filter=$rule | Get-NetFirewallApplicationFilter` +
      `;if($filter.Program -ne $program){throw 'Refuse mismatched rule removal'}` +
      `;$rule | Remove-NetFirewallRule}` +
      `;if(Get-NetFirewallRule -PolicyStore ActiveStore -Name $name -ErrorAction SilentlyContinue){throw 'Rule remains'}`
    );
  assert.equal(operation, 'watchdog');
  return `Start-Sleep -Seconds 240;${identity}$rule=Get-NetFirewallRule -PolicyStore ActiveStore -Name $name -ErrorAction SilentlyContinue;if($rule){$filter=$rule | Get-NetFirewallApplicationFilter;if($filter.Program -eq $program){$rule | Remove-NetFirewallRule}}`;
}

function powershell() {
  const root = process.env.SystemRoot;
  assert(root && path.isAbsolute(root), 'Windows SystemRoot is required.');
  return path.join(root, 'System32/WindowsPowerShell/v1.0/powershell.exe');
}

async function runPowershell(script, timeout = 30000) {
  return execute(
    powershell(),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { timeout, maxBuffer: 8192, windowsHide: true },
  );
}

export async function windowsOfflineNetworkGate({ kit, prefix, environment }) {
  assert.equal(process.platform, 'win32');
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Windows Firewall isolation is limited to disposable CI runners.');
  assert.equal(process.env.RUNNER_OS, 'Windows', 'A GitHub-hosted Windows runner is required.');
  const name = `YanbotHarnessOffline-${process.pid}-${randomUUID()}`;
  const program = path.resolve(process.execPath);
  let created = false;
  try {
    const result = await runPowershell(powershellScript(name, program, 'create'));
    assert.equal(JSON.parse(result.stdout).status, 'created');
    created = true;
    const watchdog = spawn(
      powershell(),
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(powershellScript(name, program, 'watchdog'), 'utf16le').toString('base64'),
      ],
      { detached: true, stdio: 'ignore', windowsHide: true },
    );
    await new Promise((resolve, reject) => {
      watchdog.once('spawn', resolve);
      watchdog.once('error', reject);
    });
    watchdog.unref();
    const child = await execute(
      process.execPath,
      [
        path.join(import.meta.dirname, 'windows-offline-network-child.mjs'),
        path.join(kit.directory, 'install-local.mjs'),
        prefix,
        kit.externalTestTrust,
      ],
      { env: environment, timeout: 200000, maxBuffer: 8192, windowsHide: true },
    );
    return JSON.parse(child.stdout);
  } finally {
    if (created) await runPowershell(powershellScript(name, program, 'remove'));
  }
}
