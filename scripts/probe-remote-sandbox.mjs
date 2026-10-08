import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { DockerSandboxAdapter, reapUnstartedContainers } from '../packages/sandbox-docker/dist/index.js';
import { CodeBuddyAdapter } from '../packages/adapter-codebuddy/dist/index.js';
import { ClaudeCodeCliAdapter } from '../packages/adapter-claude-code-cli/dist/index.js';
import { ReferenceAdapter } from '../packages/adapter-reference/dist/index.js';
import { runAdapterConformance } from '../packages/adapter-kit/dist/index.js';

const execute = promisify(execFile);
const dockerPath = process.env.HARNESS_DOCKER_PATH ?? '/usr/bin/docker';
const image = process.env.HARNESS_SANDBOX_IMAGE;
const waitImage = process.env.HARNESS_SANDBOX_WAIT_IMAGE;
const claudeImage = process.env.HARNESS_SANDBOX_CLAUDE_IMAGE;
const request = () => ({
  runId: randomUUID(),
  sessionId: randomUUID(),
  prompt: 'sandbox probe',
  permissionPolicy: 'read-only',
  configScopes: [],
  extensions: [],
});
if (process.argv.includes('--holder')) {
  const adapter = new DockerSandboxAdapter(
    {
      dockerPath,
      image: waitImage,
      snapshotRoot: process.env.HARNESS_PROBE_ROOT,
      workspacePath: process.env.HARNESS_PROBE_WORKSPACE,
    },
    new ReferenceAdapter().manifest,
  );
  const runtime = await adapter.createRuntime({});
  console.log(JSON.stringify({ ids: adapter.ownedContainerIds() }));
  for await (const event of runtime.startRun(request())) {
    if (event.type === 'run.failed') process.exit(1);
  }
  await runtime.dispose();
} else {
  assert.equal(process.platform, 'linux');
  assert.match(image ?? '', /^sha256:[a-f0-9]{64}$/);
  assert.match(waitImage ?? '', /^sha256:[a-f0-9]{64}$/);
  assert.match(claudeImage ?? '', /^sha256:[a-f0-9]{64}$/);
  const root = await mkdtemp(path.join(tmpdir(), 'harness-sandbox-probe-'));
  const workspacePath = path.join(root, 'workspace');
  await mkdir(workspacePath);
  await writeFile(path.join(workspacePath, 'input.txt'), 'snapshot-ok');
  const deployment = { dockerPath, image, snapshotRoot: root, workspacePath };
  const docker = async (args) =>
    (await execute(dockerPath, args, { timeout: 20_000, maxBuffer: 128 * 1024 })).stdout.trim();
  const exists = async (cid) =>
    (await docker(['ps', '--all', '--no-trunc', '--filter', `id=${cid}`, '--format', '{{.ID}}'])) !== '';
  const runtimes = [];
  let holder;
  let holderIds = [];
  try {
    const report = await runAdapterConformance({
      adapter: new DockerSandboxAdapter(deployment, new ReferenceAdapter().manifest),
      request: request(),
    });
    assert.equal(report.events.at(-1).type, 'run.completed');
    const sdkAdapter = new DockerSandboxAdapter(deployment, new CodeBuddyAdapter().manifest);
    assert.equal((await sdkAdapter.probe({})).available, false);
    const sdkRuntime = await sdkAdapter.createRuntime({});
    const sdkEvents = [];
    try {
      for await (const event of sdkRuntime.startRun(request())) sdkEvents.push(event);
    } finally {
      await sdkRuntime.dispose();
    }
    assert.equal(sdkEvents.at(-1).type, 'run.failed');
    assert.equal(sdkEvents.at(-1).payload.error.code, 'AUTHENTICATION_FAILED');
    const cliReport = await runAdapterConformance({
      adapter: new DockerSandboxAdapter(
        { ...deployment, image: claudeImage },
        new ClaudeCodeCliAdapter({ executablePath: '/opt/claude/claude' }).manifest,
      ),
      request: request(),
    });
    assert.equal(cliReport.events.at(-1).type, 'run.failed');
    assert.equal(cliReport.events.at(-1).payload.error.code, 'AUTHENTICATION_FAILED');
    const adapters = [
      new DockerSandboxAdapter(deployment, new ReferenceAdapter().manifest),
      new DockerSandboxAdapter(deployment, new ReferenceAdapter().manifest),
    ];
    runtimes.push(...(await Promise.all(adapters.map((adapter) => adapter.createRuntime({})))));
    const ids = adapters.flatMap((adapter) => adapter.ownedContainerIds());
    assert.equal(new Set(ids).size, 2);
    const abandoned = await docker([
      'create',
      '--label',
      'io.yanbot.harness.sandbox=1',
      '--name',
      'harness-sandbox-' + randomUUID(),
      image,
    ]);
    holderIds.push(abandoned);
    await delay(1100);
    assert.equal(await reapUnstartedContainers(dockerPath, 1000), 1);
    assert.equal(await exists(abandoned), false);
    holderIds = [];
    for (const cid of ids) {
      const [info] = JSON.parse(await docker(['inspect', cid]));
      assert.equal(info.Config.User, '65532:65532');
      assert.equal(info.HostConfig.ReadonlyRootfs, true);
      assert.equal(info.HostConfig.NetworkMode, 'none');
      assert.equal(info.HostConfig.LogConfig.Type, 'none');
      assert.equal(info.HostConfig.PidsLimit, 256);
      assert.equal(info.HostConfig.Memory, 512 * 1024 * 1024);
      assert.equal(info.HostConfig.MemorySwap, 512 * 1024 * 1024);
      assert.equal(info.HostConfig.NanoCpus, 1e9);
      assert(info.HostConfig.CapDrop.includes('ALL'));
      assert(info.HostConfig.SecurityOpt.includes('no-new-privileges=true'));
      assert.equal(
        info.Mounts.some((mount) => mount.Type === 'bind'),
        false,
      );
      assert.equal(
        await docker([
          'exec',
          cid,
          'node',
          '-e',
          "console.log(require('fs').readFileSync('/home/sandbox/workspace/input.txt','utf8'))",
        ]),
        'snapshot-ok',
      );
      assert.equal(
        await docker([
          'exec',
          cid,
          'node',
          '-e',
          "try{require('fs').writeFileSync('/rootfs-write','no');process.exit(1)}catch(e){if(e.code!=='EROFS'&&e.code!=='EACCES')process.exit(2);console.log('denied')}",
        ]),
        'denied',
      );
      assert.equal(
        await docker([
          'exec',
          cid,
          'node',
          '-e',
          "const s=require('net').connect(443,'1.1.1.1');s.once('connect',()=>process.exit(1));s.once('error',()=>{console.log('denied');s.destroy()});s.setTimeout(1000,()=>{console.log('denied');s.destroy()})",
        ]),
        'denied',
      );
    }
    await docker(['exec', ids[0], 'node', '-e', "require('fs').writeFileSync('/tmp/private-marker','owned')"]);
    assert.equal(
      await docker(['exec', ids[1], 'node', '-e', "console.log(require('fs').existsSync('/tmp/private-marker'))"]),
      'false',
    );
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
    for (const cid of ids) assert.equal(await exists(cid), false);
    const cancel = await runAdapterConformance({
      adapter: new DockerSandboxAdapter({ ...deployment, image: waitImage }, new ReferenceAdapter().manifest),
      request: request(),
      cancelAfterEvents: 1,
    });
    assert.equal(cancel.events.at(-1).type, 'run.cancelled');
    holder = spawn(process.execPath, [import.meta.filename, '--holder'], {
      env: { ...process.env, HARNESS_PROBE_ROOT: root, HARNESS_PROBE_WORKSPACE: workspacePath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const line = await new Promise((resolve, reject) => {
      const timer = globalThis.setTimeout(() => reject(new Error('Holder startup timed out')), 20_000);
      let text = '';
      holder.stdout.on('data', (chunk) => {
        text += chunk;
        if (text.includes('\n')) {
          globalThis.clearTimeout(timer);
          resolve(text.split('\n')[0]);
        }
      });
      holder.once('error', reject);
      holder.once('exit', () => {
        globalThis.clearTimeout(timer);
        reject(new Error('Holder exited before readiness'));
      });
    });
    holderIds = JSON.parse(line).ids;
    assert.equal(holderIds.length, 1);
    assert.equal(await exists(holderIds[0]), true);
    const closed = once(holder, 'close');
    holder.kill('SIGKILL');
    await closed;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && (await exists(holderIds[0]))) await delay(250);
    assert.equal(await exists(holderIds[0]), false, 'Parent death must remove its container');
    const output = path.resolve(process.argv[2] ?? 'evidence');
    await mkdir(output, { recursive: true });
    await writeFile(
      path.join(output, 'remote-sandbox.json'),
      JSON.stringify(
        {
          status: 'passed',
          image,
          waitImage,
          claudeImage,
          sourceCommit: process.env.GITHUB_SHA ?? 'local',
          checks: [
            'reference-conformance',
            'real-claude-cli-no-credentials',
            'codebuddy-sdk-missing-credential',
            'nonroot-readonly-resource-policy',
            'network-denied',
            'snapshot-transfer',
            'concurrent-isolation',
            'cancel',
            'parent-death-auto-remove',
            'abandoned-create-reaper',
          ],
          paidVendorEvidence: false,
        },
        null,
        2,
      ) + '\n',
    );
    console.log('Remote sandbox actual Docker probe passed.');
  } finally {
    if (holder && holder.exitCode === null && holder.signalCode === null) holder.kill('SIGKILL');
    await Promise.allSettled(runtimes.map((runtime) => runtime.dispose()));
    for (const cid of holderIds) await docker(['rm', '--force', cid]).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}
