import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const helper = path.resolve(process.argv[2] ?? 'native-build/managed-job-host.exe');
assert.equal(process.platform, 'win32');
const fixture = path.join(import.meta.dirname, 'fixtures/job-owned-root.mjs');
const results = [];
async function until(callback, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      const value = await callback();
      if (value) return value;
    } catch {
      /* Fixture not ready yet. */
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Owned fixture observation timed out.');
}
async function endpoint(root, name) {
  return until(async () => JSON.parse(await readFile(path.join(root, name + '.json'), 'utf8')));
}
async function alive(value, authorization, method = 'GET', suffix = '') {
  try {
    const response = await fetch('http://127.0.0.1:' + value.port + suffix, {
      method,
      headers: { authorization },
      signal: AbortSignal.timeout(500),
    });
    await response.arrayBuffer();
    return response.ok;
  } catch {
    return false;
  }
}
async function start(t, mode = 'detached') {
  const root = await mkdtemp(path.join(tmpdir(), 'harness-job-路径 space & #-'));
  const authorization = randomUUID();
  const child = spawn(helper, ['--', process.execPath, fixture, root, authorization, helper, mode], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  let error = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
    assert(output.length < 8192);
  });
  child.stderr.on('data', (chunk) => {
    error += chunk;
    assert(error.length < 8192);
  });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  t.after(async () => {
    child.stdin.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    for (const name of ['worker', 'root']) {
      try {
        await alive(JSON.parse(await readFile(path.join(root, name + '.json'), 'utf8')), authorization, 'POST');
      } catch {
        /* Self-expiry remains. */
      }
    }
  });
  const current = await endpoint(root, 'root');
  const worker = await endpoint(root, 'worker');
  assert(await alive(current, authorization));
  assert(await alive(worker, authorization));
  return { child, exited, current, worker, authorization, root, output: () => output, error: () => error };
}
async function gone(f) {
  await until(async () => !(await alive(f.worker, f.authorization)), 7000);
}
for (const scenario of [
  'stop',
  'eof',
  'root-exit',
  'root-crash',
  'host-kill',
  'nested',
  'breakaway',
  'invalid-control',
]) {
  await test('Job host owns descendants: ' + scenario, { timeout: 20000 }, async (t) => {
    const f = await start(t, scenario);
    if (scenario === 'breakaway') assert.deepEqual(f.current.breakaway, { created: false, error: 5 });
    if (scenario === 'host-kill') f.child.kill('SIGKILL');
    else if (scenario === 'root-exit' || scenario === 'root-crash')
      await alive(f.current, f.authorization, 'POST', scenario === 'root-crash' ? '/crash' : '');
    else if (scenario === 'eof') f.child.stdin.end();
    else f.child.stdin.end(scenario === 'invalid-control' ? 'invalid\n' : 'stop\n');
    await gone(f);
    const result = await f.exited;
    if (scenario !== 'host-kill') {
      assert.equal(result.code, scenario === 'invalid-control' ? 1 : 0, f.error());
      assert(f.output().includes('"activeProcesses":0'));
    }
    results.push({ scenario, status: 'passed', detachedDescendantSurvives: false });
  });
}
await test('Two Jobs do not terminate one another', { timeout: 25000 }, async (t) => {
  const a = await start(t);
  const b = await start(t);
  a.child.stdin.end('stop\n');
  await gone(a);
  await a.exited;
  assert(await alive(b.current, b.authorization));
  assert(await alive(b.worker, b.authorization));
  b.child.stdin.end('stop\n');
  await gone(b);
  await b.exited;
  results.push({ scenario: 'concurrent-isolation', status: 'passed' });
});
await test('Invalid executable fails before user code and leaks no lease', { timeout: 10000 }, async () => {
  const child = spawn(helper, ['--', path.join(path.dirname(helper), 'not-a-real-executable.exe')], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.resume();
  child.stderr.resume();
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  assert.equal(code, 1);
  child.stdin.destroy();
  results.push({ scenario: 'invalid-executable', status: 'passed' });
});
await writeFile(
  path.join(path.dirname(helper), 'job-containment-results.json'),
  JSON.stringify(
    {
      schemaVersion: 1,
      target: 'win32-x64',
      kind: 'native-mechanism-not-sdk-certification',
      status: results.length === 10 ? 'passed' : 'failed',
      results,
    },
    null,
    2,
  ) + '\n',
);
