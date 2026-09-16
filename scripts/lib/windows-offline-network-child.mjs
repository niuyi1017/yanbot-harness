import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import net from 'node:net';
import { release } from 'node:os';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const [installer, prefix, trust] = process.argv.slice(2);
assert.equal(process.platform, 'win32');
assert(installer && prefix && trust);
const externalConnect = await new Promise((resolve, reject) => {
  const socket = net.connect({ host: '192.0.2.1', port: 443 });
  socket.setTimeout(2500, () => {
    socket.destroy();
    resolve('OS_BLOCK_TIMEOUT');
  });
  socket.once('connect', () => {
    socket.destroy();
    reject(new Error('Unexpected external connectivity.'));
  });
  socket.once('error', (error) => resolve(error.code));
});
const result = await execute(process.execPath, [installer, '--prefix', prefix, '--trusted-key-file', trust], {
  env: process.env,
  timeout: 180000,
  maxBuffer: 8192,
  windowsHide: true,
});
const installation = JSON.parse(result.stdout);
assert.equal(installation.reference.terminal, 'run.completed');
console.log(
  JSON.stringify({
    status: 'passed',
    platform: 'win32',
    kernel: release(),
    externalConnect,
    firewallScope: 'current-node-program-internet-only',
    loopbackAllowed: true,
    installation,
  }),
);
