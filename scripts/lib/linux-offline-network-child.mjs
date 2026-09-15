import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import net from 'node:net';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const [uidText, gidText, installer, prefix, trust, environmentText] = process.argv.slice(2);
const uid = Number(uidText);
const gid = Number(gidText);
assert.equal(process.platform, 'linux');
assert.equal(process.getuid(), 0);
assert(Number.isSafeInteger(uid) && uid > 0 && Number.isSafeInteger(gid) && gid > 0);
// Only this fresh network namespace is changed. Drop privilege before loading any kit/npm code.
await execute('/usr/sbin/ip', ['link', 'set', 'lo', 'up'], { timeout: 5000 });
process.setgroups([]);
process.setgid(gid);
process.setuid(uid);
assert.equal(process.getuid(), uid);
const externalConnect = await new Promise((resolve, reject) => {
  const socket = net.connect({ host: '192.0.2.1', port: 443 });
  socket.setTimeout(2000, () => {
    socket.destroy();
    reject(new Error('Network isolation probe timed out.'));
  });
  socket.once('connect', () => {
    socket.destroy();
    reject(new Error('Unexpected external connectivity.'));
  });
  socket.once('error', (error) => resolve(error.code));
});
assert.equal(externalConnect, 'ENETUNREACH');
const result = await execute(process.execPath, [installer, '--prefix', prefix, '--trusted-key-file', trust], {
  env: JSON.parse(environmentText),
  timeout: 180000,
  maxBuffer: 8192,
});
const installation = JSON.parse(result.stdout);
assert.equal(installation.reference.terminal, 'run.completed');
console.log(
  JSON.stringify({
    status: 'passed',
    platform: 'linux',
    externalConnect,
    loopbackAllowed: true,
    privilegesDropped: true,
    installation,
  }),
);
