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
  status: results.length === 5 ? 'passed' : 'failed',
  results,
  pending: [
    'host SIGKILL and parent crash ownership proof',
    'Runtime guest and SDK/SSE integration',
    'signed guest image supply chain',
  ],
};
await writeFile(path.join(root, 'vm-test-results.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ status: report.status, report: path.join(root, 'vm-test-results.json') }));
