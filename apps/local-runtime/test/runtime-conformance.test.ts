import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { ReferenceAdapter, type ReferenceScenario } from '@yanbot-harness/adapter-reference';
import { runtimeDiscoverySchema } from '@yanbot-harness/contracts';
import {
  LocalRuntimeTestClient,
  createTemporaryStateRoot,
  verifyRuntimeCancellationConformance,
  verifyRuntimeDiscoveryConformance,
  verifyRuntimeInteractionConformance,
  verifyRuntimeRunConformance,
  type RuntimeConformanceDriver,
} from '@yanbot-harness/testing';
import { afterEach, describe, it } from 'vitest';

import { startLocalRuntime, type LocalRuntimeHandle } from '../src/server.js';

const adapterId = 'cn.yanbot.reference';
const cleanups: Array<() => Promise<void>> = [];
const runtimes: LocalRuntimeHandle[] = [];

afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('Local Runtime public conformance', () => {
  it('conforms for discovery and public resources', async () => {
    await verifyRuntimeDiscoveryConformance(await localDriver({ kind: 'text', chunks: ['discovery'] }));
  });

  it('conforms for run events and idempotency', async () => {
    await verifyRuntimeRunConformance(await localDriver({ kind: 'text', chunks: ['conformance'] }));
  });

  it('conforms for interaction disconnect and replay', async () => {
    await verifyRuntimeInteractionConformance(
      await localDriver({ kind: 'question', prompt: 'Choose?', answerResult: 'answered' }),
    );
  });

  it('conforms for cancellation and one terminal event', async () => {
    await verifyRuntimeCancellationConformance(await localDriver({ kind: 'wait-for-cancel' }));
  });
});

async function localDriver(scenario: ReferenceScenario): Promise<RuntimeConformanceDriver> {
  const temporary = await createTemporaryStateRoot('yanbot-local-conformance-');
  cleanups.push(temporary.cleanup);
  const workspace = path.join(temporary.path, 'workspace');
  await mkdir(workspace);
  const runtime = await startLocalRuntime({
    stateRoot: path.join(temporary.path, 'state'),
    adapters: [new ReferenceAdapter({ scenario })],
  });
  runtimes.push(runtime);
  const client = new LocalRuntimeTestClient({ ...runtime, routePrefix: '/v1' });
  const grant = await client.issueWorkspaceGrant({ path: workspace });
  return {
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
  };
}
