import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { startManagedRuntime } from '../packages/sdk/dist/index.js';
/* global fetch, AbortSignal */

assert(process.platform === 'darwin' && process.arch === 'arm64');
const [binaryArgument, configArgument] = process.argv.slice(2);
assert(binaryArgument && configArgument);
const binary = path.resolve(binaryArgument);
const configuration = JSON.parse(await readFile(path.resolve(configArgument), 'utf8'));
const root = await mkdtemp(path.join(tmpdir(), 'harness-vm-runtime-'));
const execute = promisify(execFile);
const resolver = {
  entryPath: binary,
  runtimeVersion: '0.1.0-preview.3',
  protocolVersion: '1.0.0',
  managedProtocolVersion: 1,
  containment: {
    kind: 'macos-vm-v1',
    executablePath: binary,
    kernel: configuration.kernel,
    initrd: configuration.initrd,
  },
};
const workspace = path.join(root, '工作区 spaces');
await mkdir(workspace);
await writeFile(path.join(workspace, 'sentinel.txt'), 'user-owned-marker');
const results = [];
async function backendPids() {
  return (await execute('/bin/ps', ['-axo', 'pid,comm'])).stdout
    .split('\n')
    .filter((line) =>
      line.includes(
        '/com.apple.Virtualization.VirtualMachine.xpc/Contents/MacOS/com.apple.Virtualization.VirtualMachine',
      ),
    )
    .map((line) => Number(line.trim().split(/\s/u)[0]));
}
async function waitFor(check, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await setTimeout(100);
  }
  throw new Error('VM test observation timed out.');
}
for (const scenario of ['text', 'question', 'wait-for-cancel']) {
  await test('Actual VM Runtime HTTP/SSE: ' + scenario, { timeout: 60000 }, async (t) => {
    const stateRoot = path.join(root, scenario);
    const handle = await startManagedRuntime({
      runtimeResolver: async () => resolver,
      requireContainment: true,
      reference: true,
      startupTimeoutMs: 45000,
      shutdownTimeoutMs: 10000,
      stateRoot,
      environment: { YANBOT_HARNESS_REFERENCE_SCENARIO: scenario },
      vm: { workspaces: [{ path: workspace, readOnly: true }] },
    });
    t.after(() => handle.close());
    assert.equal((await handle.client.health()).status, 'ok');
    assert.equal((await fetch(handle.origin + '/local/health')).status, 401);
    const descriptor = JSON.parse(await readFile(handle.descriptorPath, 'utf8'));
    assert.equal(descriptor.pid, handle.pid);
    const guestState = (await readdir(stateRoot)).find((name) => name.startsWith('guest-'));
    const guestDescriptor = JSON.parse(await readFile(path.join(stateRoot, guestState, 'runtime.json'), 'utf8'));
    assert.notEqual(guestDescriptor.pid, handle.pid, 'Guest PID must not masquerade as the host owner.');
    assert.equal(
      (
        await fetch(handle.origin + '/__harness/bootstrap', {
          method: 'POST',
          headers: { authorization: 'Bearer ' + descriptor.accessToken },
        })
      ).status,
      404,
    );
    await assert.rejects(handle.client.grantWorkspace({ path: root }), (error) => error.status === 403);
    const grant = await handle.client.grantWorkspace({ path: workspace });
    const session = await handle.client.createSession({ adapterId: 'cn.yanbot.reference' });
    const run = await handle.client.createRun(session.sessionId, {
      prompt: 'VM integration',
      workspaceGrant: grant.grant,
      permissionPolicy: 'interactive',
      configScopes: [],
      extensions: [],
      resume: false,
    });
    const events = [];
    for await (const event of run.events({ signal: AbortSignal.timeout(20000) })) {
      events.push(event.type);
      if (event.type === 'interaction.requested' && event.payload.kind === 'question')
        await run.respond({
          requestId: event.payload.requestId,
          action: 'submit',
          answers: { [event.payload.questions[0].id]: 'yes' },
        });
      if (scenario === 'wait-for-cancel' && event.type === 'run.started') await run.cancel('VM cancellation probe');
    }
    assert(events.includes(scenario === 'wait-for-cancel' ? 'run.cancelled' : 'run.completed'));
    if (scenario === 'question') assert(events.includes('interaction.resolved'));
    for (let replay = 0; replay < 3; replay++) {
      const replayed = [];
      for await (const event of handle.client.events(run.run.runId, { signal: AbortSignal.timeout(20000) }))
        replayed.push(event.type);
      assert.deepEqual(replayed, events);
      assert.equal((await handle.client.health()).status, 'ok');
      assert((await handle.client.listSessions()).some((entry) => entry.sessionId === session.sessionId));
    }
    await Promise.all([handle.close(), handle.close()]);
    assert.equal(await readFile(path.join(workspace, 'sentinel.txt'), 'utf8'), 'user-owned-marker');
    assert(!(await readdir(stateRoot)).includes('runtime.json'));
    assert.equal(await readFile(path.join(stateRoot, 'vm-lease'), 'utf8'), 'stopped\n');
    if (scenario === 'text') {
      const reopened = await startManagedRuntime({
        runtimeResolver: async () => resolver,
        requireContainment: true,
        reference: true,
        stateRoot,
        startupTimeoutMs: 45000,
        shutdownTimeoutMs: 10000,
      });
      try {
        assert((await reopened.client.listSessions()).some((entry) => entry.sessionId === session.sessionId));
        await assert.rejects(
          startManagedRuntime({
            runtimeResolver: async () => resolver,
            requireContainment: true,
            reference: true,
            stateRoot,
            startupTimeoutMs: 45000,
          }),
          /descriptor already exists/u,
        );
        assert.equal((await reopened.client.health()).status, 'ok');
      } finally {
        await reopened.close();
      }
      results.push({ scenario: 'persistent-reopen-and-same-root-refusal', status: 'passed' });
    }
    results.push({ scenario, status: 'passed', actualVM: true, publicProtocol: true, explicitWorkspace: true });
  });
}
await test('SDK parent crash stops the actual Runtime VM', { timeout: 60000 }, async (t) => {
  if ((await backendPids()).length) {
    t.skip('Other VM present; cannot safely attribute backend evidence.');
    return;
  }
  const sdk = pathToFileURL(path.resolve(import.meta.dirname, '../packages/sdk/dist/index.js')).href;
  const parentState = path.join(root, 'parent-state');
  const holder = `import { startManagedRuntime } from ${JSON.stringify(sdk)};
    const handle = await startManagedRuntime({ runtimeResolver: async()=>(${JSON.stringify(resolver)}), requireContainment:true,
      reference:true,stateRoot:${JSON.stringify(parentState)},startupTimeoutMs:45000,shutdownTimeoutMs:10000});
    process.stdout.write(JSON.stringify({ready:true,pid:handle.pid})+'\\n');
    setTimeout(()=>handle.close(),45000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', holder], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  let errors = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
    assert(output.length < 8192);
  });
  child.stderr.on('data', (chunk) => {
    errors += chunk;
    assert(errors.length < 16384);
  });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error('SDK parent failed: ' + errors);
    return output.includes('"ready":true');
  }, 50000);
  assert.equal((await backendPids()).length, 1);
  child.kill('SIGKILL');
  await closed;
  await waitFor(async () => (await backendPids()).length === 0);
  assert.equal(await readFile(path.join(parentState, 'vm-lease'), 'utf8'), 'stopped\n');
  assert(!(await readdir(parentState)).includes('runtime.json'));
  const recovered = await startManagedRuntime({
    runtimeResolver: async () => resolver,
    requireContainment: true,
    reference: true,
    stateRoot: parentState,
    startupTimeoutMs: 45000,
    shutdownTimeoutMs: 10000,
  });
  await recovered.close();
  results.push({ scenario: 'sdk-parent-sigkill', status: 'passed', ownedVMBackendExited: true });
});
await test('Independent VM instances do not share lifecycle or state', { timeout: 60000 }, async () => {
  const first = await startManagedRuntime({
    runtimeResolver: async () => resolver,
    requireContainment: true,
    reference: true,
    startupTimeoutMs: 45000,
    shutdownTimeoutMs: 10000,
  });
  let second;
  try {
    second = await startManagedRuntime({
      runtimeResolver: async () => resolver,
      requireContainment: true,
      reference: true,
      startupTimeoutMs: 45000,
      shutdownTimeoutMs: 10000,
    });
    assert.notEqual(first.pid, second.pid);
    assert.notEqual(first.origin, second.origin);
    await first.close();
    assert.equal((await second.client.health()).status, 'ok');
    results.push({ scenario: 'concurrent-vm-isolation', status: 'passed' });
  } finally {
    await Promise.all([first.close(), second?.close()]);
  }
});
const report = {
  schemaVersion: 1,
  kind: 'vm-runtime-development-integration',
  target: 'darwin-arm64',
  guestTarget: 'linux-arm64',
  status: results.length === 6 ? 'passed' : 'failed',
  results,
  productionCertified: false,
};
await writeFile(path.join(root, 'vm-runtime-results.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ status: report.status, report: path.join(root, 'vm-runtime-results.json') }));
