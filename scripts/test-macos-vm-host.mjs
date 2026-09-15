import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout } from 'node:timers';
import { promisify } from 'node:util';
import test from 'node:test';

assert.equal(process.platform, 'darwin');
const [binaryArg, configArg] = process.argv.slice(2);
assert(binaryArg && configArg);
const binary = path.resolve(binaryArg);
const config = path.resolve(configArg);
const execute = promisify(execFile);
const root = await mkdtemp(path.join(tmpdir(), 'harness-vm-tests-'));
const results = [];
async function backendPids() {
  const { stdout } = await execute('/bin/ps', ['-axo', 'pid,comm']);
  return stdout
    .split('\n')
    .filter((line) =>
      line.includes(
        '/com.apple.Virtualization.VirtualMachine.xpc/Contents/MacOS/com.apple.Virtualization.VirtualMachine',
      ),
    )
    .map((line) => Number(line.trim().split(/\s/u)[0]));
}
async function waitFor(check, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Owned VM lifecycle observation timed out.');
}
for (const scenario of ['stop', 'eof', 'invalid-control']) {
  await test('Real VM stops its detached guest tree: ' + scenario, { timeout: 25000 }, async (t) => {
    const child = spawn(binary, ['--probe-run', config], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let errors = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
      assert(output.length < 16384);
    });
    child.stderr.on('data', (chunk) => {
      errors += chunk;
      assert(errors.length < 16384);
    });
    const closed = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve(code));
    });
    t.after(() => {
      child.stdin.destroy();
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    });
    const deadline = Date.now() + 18000;
    while (!output.includes('"type":"guest-ready"') || !output.includes('"type":"guest-descendant-ready"')) {
      if (Date.now() > deadline || child.exitCode !== null || child.signalCode !== null)
        throw new Error('VM guest readiness failed: ' + output + errors);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    child.stdin.end(scenario === 'eof' ? undefined : scenario === 'invalid-control' ? 'bad\n' : 'stop\n');
    assert.equal(await closed, scenario === 'invalid-control' ? 1 : 0, errors + output);
    assert(output.includes('"state":"stopped"'));
    results.push({ scenario, status: 'passed', vmStopped: true, detachedGuestObservedBeforeStop: true });
  });
}
for (const scenario of ['host-sigkill', 'parent-sigkill']) {
  await test('Owned Virtualization backend exits after ' + scenario, { timeout: 25000 }, async (t) => {
    // This evidence requires an otherwise idle VM environment. Never identify or terminate another VM by PID.
    if ((await backendPids()).length !== 0) {
      t.skip('Another Virtualization VM is present; no ownership inference is allowed.');
      return;
    }
    const holder = `
      const {spawn}=require('node:child_process');
      const child=spawn(${JSON.stringify(binary)},['--probe-run',${JSON.stringify(config)}],{stdio:['pipe','pipe','pipe']});
      child.stdout.pipe(process.stdout);child.stderr.resume();
      setTimeout(()=>child.stdin.end('stop\\n'),20000);
    `;
    const child =
      scenario === 'host-sigkill'
        ? spawn(binary, ['--probe-run', config], { stdio: ['pipe', 'pipe', 'pipe'] })
        : spawn(process.execPath, ['-e', holder], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
      assert(output.length < 16384);
    });
    child.stderr.resume();
    const closed = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    t.after(() => {
      child.stdin.destroy();
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    });
    await waitFor(async () => output.includes('"type":"guest-descendant-ready"'));
    const backends = await backendPids();
    assert.equal(backends.length, 1, 'Ambiguous VM ownership; no backend process is ever killed by this test.');
    child.kill('SIGKILL'); // Only the ChildProcess created in this invocation, never the backend's numeric PID.
    await closed;
    await waitFor(async () => !(await backendPids()).includes(backends[0]));
    assert.equal((await backendPids()).length, 0);
    results.push({
      scenario,
      status: 'passed',
      detachedGuestObservedBeforeStop: true,
      ownedBackendExited: true,
      precondition: 'no-other-virtualization-vm',
    });
  });
}
await test('Modified guest bytes and unknown configuration fields are rejected before boot', async () => {
  const original = JSON.parse(await readFile(config, 'utf8'));
  for (const data of [
    { ...original, unexpected: true },
    { ...original, kernel: { ...original.kernel, sha256: '0'.repeat(64) } },
  ]) {
    const file = path.join(root, 'invalid-' + results.length + '.json');
    await writeFile(file, JSON.stringify(data));
    await assert.rejects(
      execute(binary, ['--validate', file], { timeout: 10000 }),
      (error) => error.code === 1 && !error.stdout.includes('"type":"started"'),
    );
    results.push({ scenario: 'invalid-configuration-or-digest', status: 'passed' });
  }
});
const report = {
  schemaVersion: 1,
  target: 'darwin-arm64',
  guestTarget: 'linux-arm64',
  kind: 'real-vm-mechanism-not-sdk-certification',
  status: results.length === 7 ? 'passed' : 'failed',
  results,
  pending: ['Runtime guest and SDK/SSE integration', 'signed guest image supply chain'],
};
await writeFile(path.join(root, 'vm-test-results.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ status: report.status, report: path.join(root, 'vm-test-results.json') }));
