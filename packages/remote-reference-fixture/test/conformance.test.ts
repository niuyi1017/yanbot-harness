import { HarnessClient } from '@yanbot-harness/sdk';
import {
  verifyRuntimeCancellationConformance,
  verifyRuntimeDiscoveryConformance,
  verifyRuntimeInteractionConformance,
  verifyRuntimeRunConformance,
  type RuntimeConformanceDriver,
} from '@yanbot-harness/testing';
import { afterEach, describe, it } from 'vitest';

import {
  createRemoteReferenceFixture,
  type RemoteReferenceFixture,
  type RemoteReferenceFixtureOptions,
} from '../src/index.js';

const adapterId = 'cn.yanbot.reference';
const fixtures: RemoteReferenceFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

describe('Remote Reference public conformance', () => {
  it('conforms for discovery and public resources', async () => {
    await verifyRuntimeDiscoveryConformance(await remoteDriver({ scenario: { kind: 'text', chunks: ['discovery'] } }));
  });

  it('conforms for run events and idempotency', async () => {
    await verifyRuntimeRunConformance(await remoteDriver({ scenario: { kind: 'text', chunks: ['conformance'] } }));
  });

  it('conforms for interaction disconnect and replay', async () => {
    await verifyRuntimeInteractionConformance(
      await remoteDriver({ scenario: { kind: 'question', prompt: 'Choose?', answerResult: 'answered' } }),
    );
  });

  it('conforms for cancellation and one terminal event', async () => {
    await verifyRuntimeCancellationConformance(await remoteDriver({ scenario: { kind: 'wait-for-cancel' } }));
  });
});

async function remoteDriver(options: RemoteReferenceFixtureOptions): Promise<RuntimeConformanceDriver> {
  const fixture = await createRemoteReferenceFixture(options);
  fixtures.push(fixture);
  const tenantId = 'tenant-a';
  const token = fixture.issueToken({ tenantId, subjectId: 'user-a' });
  const workspace = fixture.prepareSnapshot({ tenantId });
  const client = await HarnessClient.connect({
    mode: 'remote',
    origin: fixture.origin,
    tokenProvider: async () => ({ accessToken: token }),
    fetch: fixture.fetch,
  });
  return {
    adapterId,
    expectedExecutionMode: 'remote',
    health: () => client.health(),
    listAdapters: () => client.listAdapters(),
    listModels: (selectedAdapterId) => client.listModels(selectedAdapterId),
    createSession: (input) => client.createSession(input),
    listSessions: () => client.listSessions(),
    getSession: (sessionId) => client.getSession(sessionId),
    createRun: async (sessionId, input, createOptions) => {
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
        createOptions,
      );
      return { run: handle.run, reused: handle.reused };
    },
    getRun: (runId) => client.getRun(runId),
    cancelRun: (runId, reason) => client.cancelRun(runId, reason),
    respond: (response) => client.respondToInteraction(response),
    events: (runId, eventOptions) => client.events(runId, eventOptions),
  };
}
