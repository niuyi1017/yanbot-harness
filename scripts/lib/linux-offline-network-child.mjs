import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readlink, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
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
assert.notEqual(await readlink('/proc/self/ns/mnt'), await readlink('/proc/1/ns/mnt'), 'Refuse host mount namespace.');
const limitedCache = prefix + '-limited-cache';
await mkdir(limitedCache, { mode: 0o700 });
assert.equal(await realpath(limitedCache), path.resolve(limitedCache));
await execute(
  '/usr/bin/mount',
  ['-t', 'tmpfs', '-o', `size=1m,mode=0700,uid=${uid},gid=${gid}`, 'harness-owned-fault', limitedCache],
  { timeout: 5000 },
);
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
const faultFile = path.join(prefix, '.harness-cache-fault.mjs');
await writeFile(
  faultFile,
  `
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { resolveInstalledRuntime } from '@yanbot-harness/runtime';
const trustedKeys=JSON.parse(await readFile(${JSON.stringify(trust)},'utf8'));
const before=await resolveInstalledRuntime({trustedKeys,signal:AbortSignal.timeout(120000)});
const cacheRoot=${JSON.stringify(limitedCache)};
const probe=cacheRoot+'/space-probe';
try { await assert.rejects(writeFile(probe,'x'.repeat(2*1024*1024)),{code:'ENOSPC'}); } finally { await rm(probe,{force:true}); }
await assert.rejects(resolveInstalledRuntime({trustedKeys,cacheRoot,signal:AbortSignal.timeout(120000)}),{reason:'CACHE_UNAVAILABLE'});
assert.deepEqual(await resolveInstalledRuntime({trustedKeys,signal:AbortSignal.timeout(120000)}),before);
assert.equal((await readdir(cacheRoot,{recursive:true,withFileTypes:true})).filter(e=>e.isFile()).length,0);
console.log(JSON.stringify({status:'passed',actualDiskError:'ENOSPC',oldCachePreserved:true,partialFilesRemoved:true}));
`,
);
const diskFailure = JSON.parse(
  (
    await execute(process.execPath, [faultFile], {
      env: JSON.parse(environmentText),
      timeout: 180000,
      maxBuffer: 8192,
    })
  ).stdout,
);
console.log(
  JSON.stringify({
    status: 'passed',
    platform: 'linux',
    externalConnect,
    loopbackAllowed: true,
    privilegesDropped: true,
    installation,
    diskFailure,
  }),
);
