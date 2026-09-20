import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';

import { ReferenceAdapter } from '../../packages/adapter-reference/dist/index.js';
import {
  HARNESS_PROTOCOL_VERSION,
  HARNESS_RELEASE_VERSION,
  runtimeDiscoverySchema,
} from '../../packages/contracts/dist/index.js';
import { createRemoteReferenceFixture } from '../../packages/remote-reference-fixture/dist/index.js';
import { HarnessClient } from '../../packages/sdk/dist/index.js';
import {
  LocalRuntimeTestClient,
  createTemporaryStateRoot,
  verifyRuntimeCancellationConformance,
  verifyRuntimeDiscoveryConformance,
  verifyRuntimeInteractionConformance,
  verifyRuntimeRunConformance,
} from '../../packages/testing/dist/index.js';
import { startLocalRuntime } from '../../apps/local-runtime/dist/server.js';

const execute = promisify(execFile);
const adapterId = 'cn.yanbot.reference';

export const TARGETS = Object.freeze({
  'darwin-arm64': Object.freeze({ platform: 'darwin', arch: 'arm64' }),
  'win32-x64': Object.freeze({ platform: 'win32', arch: 'x64' }),
});

export const SCENARIOS = Object.freeze([
  Object.freeze({
    id: 'discovery-resources',
    scenario: Object.freeze({ kind: 'text', chunks: Object.freeze(['discovery']) }),
    verify: verifyRuntimeDiscoveryConformance,
  }),
  Object.freeze({
    id: 'run-idempotency',
    scenario: Object.freeze({ kind: 'text', chunks: Object.freeze(['conformance']) }),
    verify: verifyRuntimeRunConformance,
  }),
  Object.freeze({
    id: 'interaction-replay',
    scenario: Object.freeze({ kind: 'question', prompt: 'Choose?', answerResult: 'answered' }),
    verify: verifyRuntimeInteractionConformance,
  }),
  Object.freeze({
    id: 'cancellation',
    scenario: Object.freeze({ kind: 'wait-for-cancel' }),
    verify: verifyRuntimeCancellationConformance,
  }),
]);

export async function generatePlatformEvidence({ target, repositoryRoot, now = () => new Date() }) {
  assertTargetMatchesRunner(target);
  const source = await readSource(repositoryRoot);
  const runtimes = [];
  runtimes.push(
    await runRuntimeEvidence({
      identity: {
        runtimeKind: 'local-reference',
        executionMode: 'local',
        transport: 'loopback-http-sse',
        serviceEvidence: false,
      },
      createDriver: createLocalDriver,
    }),
  );
  runtimes.push(
    await runRuntimeEvidence({
      identity: {
        runtimeKind: 'remote-reference-fixture',
        executionMode: 'remote',
        transport: 'injected-fetch',
        serviceEvidence: false,
      },
      createDriver: createRemoteFixtureDriver,
    }),
  );
  return {
    schemaVersion: 1,
    evidenceKind: 'dual-runtime-platform',
    source,
    generatedAt: now().toISOString(),
    runner: { target, platform: process.platform, arch: process.arch, node: process.version },
    versions: { release: HARNESS_RELEASE_VERSION, protocol: HARNESS_PROTOCOL_VERSION },
    runtimes,
    remoteService: { status: 'not-run', reason: 'formal-remote-service-not-implemented' },
    status: runtimes.every((runtime) => runtime.status === 'passed') ? 'passed' : 'failed',
  };
}

export async function writeJsonAtomic(file, value) {
  const destination = path.resolve(file);
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export function assertTargetMatchesRunner(target) {
  const expected = TARGETS[target];
  if (!expected) throw new Error(`Unsupported evidence target: ${String(target)}`);
  if (process.platform !== expected.platform || process.arch !== expected.arch) {
    throw new Error(
      `Evidence target ${target} requires ${expected.platform}/${expected.arch}; current runner is ${process.platform}/${process.arch}.`,
    );
  }
}

async function readSource(repositoryRoot) {
  const options = { cwd: repositoryRoot, encoding: 'utf8', maxBuffer: 1024 * 1024 };
  const { stdout: commitOutput } = await execute('git', ['rev-parse', '--verify', 'HEAD'], options);
  const commit = commitOutput.trim();
  if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error('Git did not return a full source commit.');
  const { stdout: statusOutput } = await execute('git', ['status', '--porcelain=v1'], options);
  return { commit, dirty: statusOutput.trim().length > 0 };
}

async function runRuntimeEvidence({ identity, createDriver }) {
  const scenarios = [];
  for (const item of SCENARIOS) {
    const startedAt = performance.now();
    let resource;
    let failure;
    try {
      resource = await createDriver(item.scenario);
      await item.verify(resource.driver);
    } catch (error) {
      failure = error;
    }
    try {
      await resource?.close();
    } catch (error) {
      failure ??= error;
    }
    if (failure === undefined) {
      scenarios.push({ id: item.id, status: 'passed', durationMs: duration(startedAt) });
    } else {
      scenarios.push({
        id: item.id,
        status: 'failed',
        durationMs: duration(startedAt),
        error: sanitizeError(failure, resource?.sensitiveRoots ?? []),
      });
    }
  }
  return {
    ...identity,
    scenarios,
    status: scenarios.every((scenario) => scenario.status === 'passed') ? 'passed' : 'failed',
  };
}

async function createLocalDriver(scenario) {
  const temporary = await createTemporaryStateRoot('yanbot-dual-runtime-local-');
  const workspace = path.join(temporary.path, 'workspace');
  let runtime;
  try {
    await mkdir(workspace);
    runtime = await startLocalRuntime({
      stateRoot: path.join(temporary.path, 'state'),
      adapters: [new ReferenceAdapter({ scenario })],
    });
    const client = new LocalRuntimeTestClient({ ...runtime, routePrefix: '/v1' });
    const grant = await client.issueWorkspaceGrant({ path: workspace });
    return {
      driver: {
        adapterId,
        expectedExecutionMode: 'local',
        health: async () => runtimeDiscoverySchema.parse(await client.health()),
        listAdapters: () => client.listAdapters(),
        listModels: (selectedAdapterId) => client.listModels(selectedAdapterId),
        createSession: (input) => client.createSession(input),
        listSessions: () => client.listSessions(),
        getSession: (sessionId) => client.getSession(sessionId),
        createRun: (sessionId, input, options) =>
          client.createRun(
            sessionId,
            {
              prompt: input.prompt,
              workspaceGrant: grant.grant,
              permissionPolicy: 'interactive',
              configScopes: [],
              extensions: [],
              resume: input.resume ?? false,
            },
            options?.idempotencyKey,
          ),
        getRun: (runId) => client.getRun(runId),
        cancelRun: (runId, reason) => client.cancelRun(runId, reason),
        respond: (response) => client.respond(response),
        events: (runId, options) => client.events(runId, options),
      },
      sensitiveRoots: [temporary.path],
      close: async () => {
        await closeResources([() => runtime.close(), temporary.cleanup]);
      },
    };
  } catch (error) {
    await closeResources([...(runtime === undefined ? [] : [() => runtime.close()]), temporary.cleanup]).catch(
      () => undefined,
    );
    throw error;
  }
}

async function createRemoteFixtureDriver(scenario) {
  const stateRoot = await mkdtemp(path.join(tmpdir(), 'yanbot-dual-runtime-remote-'));
  let fixture;
  try {
    fixture = await createRemoteReferenceFixture({ scenario, stateRoot });
    const tenantId = 'matrix-tenant';
    const token = fixture.issueToken({ tenantId, subjectId: 'matrix-user' });
    const workspace = await fixture.prepareSnapshot({ tenantId });
    const client = await HarnessClient.connect({
      mode: 'remote',
      origin: fixture.origin,
      tokenProvider: async () => ({ accessToken: token }),
      fetch: fixture.fetch,
    });
    return {
      driver: {
        adapterId,
        expectedExecutionMode: 'remote',
        health: () => client.health(),
        listAdapters: () => client.listAdapters(),
        listModels: (selectedAdapterId) => client.listModels(selectedAdapterId),
        createSession: (input) => client.createSession(input),
        listSessions: () => client.listSessions(),
        getSession: (sessionId) => client.getSession(sessionId),
        createRun: async (sessionId, input, options) => {
          const handle = await client.createRun(
            sessionId,
            {
              prompt: input.prompt,
              workspace,
              permissionPolicy: 'interactive',
              configScopes: [],
              extensions: [],
              resume: input.resume ?? false,
            },
            options,
          );
          return { run: handle.run, reused: handle.reused };
        },
        getRun: (runId) => client.getRun(runId),
        cancelRun: (runId, reason) => client.cancelRun(runId, reason),
        respond: (response) => client.respondToInteraction(response),
        events: (runId, options) => client.events(runId, options),
      },
      sensitiveRoots: [stateRoot],
      close: async () => {
        await closeResources([() => fixture.close(), () => rm(stateRoot, { recursive: true, force: true })]);
      },
    };
  } catch (error) {
    await closeResources([
      ...(fixture === undefined ? [] : [() => fixture.close()]),
      () => rm(stateRoot, { recursive: true, force: true }),
    ]).catch(() => undefined);
    throw error;
  }
}

function duration(startedAt) {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

async function closeResources(cleanups) {
  const results = await Promise.allSettled(cleanups.map((cleanup) => cleanup()));
  const failed = results.find((result) => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
}

function sanitizeError(error, sensitiveRoots) {
  let message = error instanceof Error ? error.message : 'Unknown scenario failure.';
  for (const value of [process.cwd(), tmpdir(), ...sensitiveRoots]) {
    if (value) message = message.split(value).join('<redacted-path>');
  }
  message = [...message]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || code === 127 ? ' ' : character;
    })
    .join('')
    .slice(0, 512);
  return {
    name: error instanceof Error && error.name ? error.name.slice(0, 80) : 'Error',
    message: message || 'Scenario failed.',
  };
}
