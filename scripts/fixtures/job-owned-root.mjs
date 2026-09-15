import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { setTimeout, clearTimeout } from 'node:timers';
const [root, authorization, helper, mode] = process.argv.slice(2);
const worker = path.join(import.meta.dirname, 'job-owned-worker.mjs');
const file = path.join(root, 'worker.json');
const args = [worker, file, authorization];
const child =
  mode === 'nested'
    ? spawn(helper, ['--', process.execPath, ...args], { stdio: ['pipe', 'ignore', 'ignore'] })
    : spawn(process.execPath, args, { detached: true, stdio: 'ignore' });
child.unref();
let breakaway;
if (mode === 'breakaway') {
  const result = await promisify(execFile)(path.join(path.dirname(helper), 'breakaway-probe.exe'), [
    process.execPath,
    worker,
    path.join(root, 'breakaway.json'),
    authorization,
  ]);
  breakaway = JSON.parse(result.stdout);
}
const timer = setTimeout(() => process.exit(0), 30000);
const server = createServer((request, response) => {
  if (request.headers.authorization !== authorization) {
    response.writeHead(403).end();
    return;
  }
  response.end('owned root');
  if (request.method === 'POST') {
    clearTimeout(timer);
    if (request.url === '/crash') process.kill(process.pid, 'SIGKILL');
    else process.exit(0);
  }
});
// A real child must be observable before readiness; no false success from racing process startup.
for (let attempt = 0; ; attempt++) {
  try {
    await readFile(file);
    break;
  } catch {
    if (attempt >= 200) throw new Error('worker not ready');
  }
  await new Promise((resolve) => setTimeout(resolve, 25));
}
server.listen(0, '127.0.0.1', async () => {
  await writeFile(
    path.join(root, 'root.json'),
    JSON.stringify({ pid: process.pid, port: server.address().port, breakaway }),
  );
});
