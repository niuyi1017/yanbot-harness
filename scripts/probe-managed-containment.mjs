import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startManagedRuntime, HARNESS_RELEASE_VERSION } from '../packages/sdk/dist/index.js';

const { fetch, AbortSignal } = globalThis;

// Adversarial certification probe, not a unit-test waiver. A surviving child blocks the guarantee.
const root = await mkdtemp(path.join(tmpdir(), 'harness-containment-gate-'));
const endpointFile = path.join(root, 'owned-child.json');
const nonce = randomUUID();
const worker = path.join(root, 'detached-worker.mjs');
const runtime = path.resolve(import.meta.dirname, '../apps/local-runtime/dist/main.js');
await writeFile(
  worker,
  `
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
const timer=setTimeout(()=>process.exit(0),30000);
const server=createServer((req,res)=>{
 if(req.headers.authorization!==${JSON.stringify(nonce)}){res.writeHead(403);res.end();return;}
 res.end('owned fixture');
 if(req.method==='POST'){clearTimeout(timer);server.close();}
});
server.listen(0,'127.0.0.1',()=>writeFileSync(${JSON.stringify(endpointFile)},JSON.stringify({pid:process.pid,port:server.address().port}),{mode:0o600}));
`,
);
const entry = path.join(root, 'runtime-with-detached-child.mjs');
await writeFile(
  entry,
  `import ${JSON.stringify(pathToFileURL(runtime).href)};
import { spawn } from 'node:child_process';
spawn(process.execPath,[${JSON.stringify(worker)}],{detached:true,stdio:'ignore'}).unref();
`,
);
const stateRoot = path.join(root, 'state');
await mkdir(stateRoot, { mode: 0o700 });
let handle;
let endpoint;
const report = {
  schemaVersion: 1,
  version: HARNESS_RELEASE_VERSION,
  target: process.platform + '-' + process.arch,
  scenario: 'detached-descendant-after-managed-close',
  status: 'failed',
  cleanup: 'pending',
};
try {
  handle = await startManagedRuntime({
    reference: true,
    stateRoot,
    runtimeResolver: async () => ({
      entryPath: entry,
      runtimeVersion: HARNESS_RELEASE_VERSION,
      protocolVersion: '1.0.0',
      managedProtocolVersion: 1,
    }),
  });
  endpoint = JSON.parse(await readFile(endpointFile, 'utf8'));
  assert(Number.isSafeInteger(endpoint.port));
  const url = 'http://127.0.0.1:' + endpoint.port;
  assert((await fetch(url, { headers: { authorization: nonce }, signal: AbortSignal.timeout(1000) })).ok);
  await handle.close();
  let survives = false;
  try {
    survives = (await fetch(url, { headers: { authorization: nonce }, signal: AbortSignal.timeout(1000) })).ok;
  } catch {
    /* Connection gone. */
  }
  report.status = survives ? 'blocked' : 'passed';
  report.detachedDescendantSurvives = survives;
  if (survives) process.exitCode = 1;
} catch (error) {
  report.error = error.name; // Do not print fixture authorization material.
  process.exitCode = 1;
} finally {
  if (handle) await handle.close().catch(() => undefined);
  if (endpoint) {
    try {
      await fetch('http://127.0.0.1:' + endpoint.port, {
        method: 'POST',
        headers: { authorization: nonce },
        signal: AbortSignal.timeout(1000),
      });
      report.cleanup = 'authenticated-owned-fixture-shutdown';
    } catch {
      report.cleanup = 'endpoint-gone-or-30-second-self-expiry';
    }
  } else report.cleanup = '30-second-self-expiry';
  await writeFile(path.join(root, 'containment-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ...report, directory: root }));
}
