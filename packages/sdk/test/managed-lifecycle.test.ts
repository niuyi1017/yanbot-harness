import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { startManagedRuntime, HARNESS_RELEASE_VERSION, type ManagedRuntimeHandle } from '../src/index.js';

const runtimeEntry = path.resolve(import.meta.dirname, '../../../apps/local-runtime/dist/main.js');
const handles: ManagedRuntimeHandle[] = [];
const processes: ChildProcess[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.allSettled(handles.splice(0).map((handle) => handle.close()));
  for (const child of processes.splice(0))
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'managed-lifecycle-'));
  roots.push(root);
  return root;
}
function resolved(entryPath = runtimeEntry) {
  return async () => ({
    entryPath,
    runtimeVersion: HARNESS_RELEASE_VERSION,
    protocolVersion: '1.0.0',
    managedProtocolVersion: 1 as const,
  });
}
async function gone(pid: number) {
  const until = Date.now() + 3000;
  while (Date.now() < until) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

it('concurrent managed instances own distinct state and closing one preserves the other', async () => {
  const [a, b] = await Promise.all([
    startManagedRuntime({ reference: true, runtimeResolver: resolved() }),
    startManagedRuntime({ reference: true, runtimeResolver: resolved() }),
  ]);
  handles.push(a, b);
  expect(a.pid).not.toBe(b.pid);
  expect(a.descriptorPath).not.toBe(b.descriptorPath);
  await a.close();
  await expect(b.client.health()).resolves.toMatchObject({ status: 'ok' });
}, 15000);

it('parent IPC loss closes a normal Reference child while preserving caller-owned state', async () => {
  const root = await fixture();
  const state = path.join(root, 'state');
  await mkdir(state, { mode: 0o700 });
  const descriptor = path.join(state, 'runtime.json');
  const sdkEntry = pathToFileURL(path.resolve(import.meta.dirname, '../dist/index.js')).href;
  const source = path.join(root, 'owner.mjs');
  await writeFile(
    source,
    `import { startManagedRuntime } from ${JSON.stringify(sdkEntry)};
const h = await startManagedRuntime({ reference: true, stateRoot: ${JSON.stringify(state)},
 runtimeResolver: async () => (${JSON.stringify({ entryPath: runtimeEntry, runtimeVersion: HARNESS_RELEASE_VERSION, protocolVersion: '1.0.0', managedProtocolVersion: 1 })}) });
process.stdout.write(JSON.stringify({pid:h.pid})+'\\n');
setInterval(() => {}, 1000);`,
  );
  const owner = spawn(process.execPath, [source], { stdio: ['ignore', 'pipe', 'pipe'] });
  processes.push(owner);
  const ready = await Promise.race([
    once(owner.stdout!, 'data'),
    once(owner, 'exit').then(() => {
      throw new Error('owner exited');
    }),
  ]);
  const pid = (JSON.parse(String(ready[0])) as { pid: number }).pid;
  owner.kill('SIGKILL');
  await once(owner, 'exit');
  expect(await gone(pid)).toBe(true);
  await expect(stat(state)).resolves.toBeDefined();
  await expect(stat(descriptor)).rejects.toMatchObject({ code: 'ENOENT' });
}, 15000);

it('new managed path rejects insecure caller state without changing its files', async () => {
  if (process.platform === 'win32') return; // Windows ACL is exercised by the successful managed paths on its runner.
  const root = await fixture();
  const state = path.join(root, 'public-state');
  await mkdir(state, { mode: 0o755 });
  await writeFile(path.join(state, 'sentinel'), 'keep');
  await expect(
    startManagedRuntime({ reference: true, runtimeResolver: resolved(), stateRoot: state }),
  ).rejects.toMatchObject({ kind: 'runtime' });
  expect(await readFile(path.join(state, 'sentinel'), 'utf8')).toBe('keep');
});

it('graceful-then-forced cleanup reclaims an unresponsive in-group grandchild', async () => {
  const root = await fixture();
  const childFile = path.join(root, 'grandchild.pid');
  const entry = path.join(root, 'fixture.mjs');
  await writeFile(
    entry,
    `import ${JSON.stringify(pathToFileURL(runtimeEntry).href)};
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], {stdio:'ignore'});
writeFileSync(${JSON.stringify(childFile)}, String(child.pid));`,
  );
  const handle = await startManagedRuntime({
    reference: true,
    runtimeResolver: resolved(entry),
    shutdownTimeoutMs: 1500,
  });
  handles.push(handle);
  const pid = Number(await readFile(childFile, 'utf8'));
  await handle.close();
  expect(await gone(pid)).toBe(true);
}, 15000);
