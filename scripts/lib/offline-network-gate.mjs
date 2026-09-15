import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
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
