import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { ReferenceAdapter } from '@yanbot-harness/adapter-reference';
import { startLocalRuntime, type LocalRuntimeHandle } from '@yanbot-harness/local-runtime';
import { createTemporaryStateRoot } from '@yanbot-harness/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { HarnessClient, type AdapterEvent } from '../src/index.js';

const runtimes: LocalRuntimeHandle[] = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('SDK through the public local protocol', () => {
  it('discovers, runs, streams, and answers an interaction through real HTTP/SSE', async () => {
    const temporary = await createTemporaryStateRoot('yanbot-sdk-e2e-');
    cleanups.push(temporary.cleanup);
    const workspace = path.join(temporary.path, 'workspace');
    await mkdir(workspace);
    const runtime = await startLocalRuntime({
      stateRoot: path.join(temporary.path, 'state'),
      adapters: [
        new ReferenceAdapter({ scenario: { kind: 'question', prompt: 'Continue?', answerResult: 'SDK answered.' } }),
      ],
    });
    runtimes.push(runtime);
    const client = HarnessClient.fromRuntime(runtime);

    await expect(client.health()).resolves.toMatchObject({ status: 'ok' });
    await expect(client.listAdapters()).resolves.toMatchObject([{ manifest: { adapterId: 'cn.yanbot.reference' } }]);
    await expect(client.listModels('cn.yanbot.reference')).resolves.toMatchObject([
      { ref: { modelId: 'deterministic' } },
    ]);

    const grant = await client.grantWorkspace({ path: workspace });
    const session = await client.createSession({ adapterId: 'cn.yanbot.reference' });
    const handle = await client.createRun(session.sessionId, {
      prompt: 'Exercise the SDK boundary.',
      workspaceGrant: grant.grant,
      permissionPolicy: 'interactive',
      configScopes: [],
      extensions: [],
      resume: false,
    });
    const events: AdapterEvent[] = [];
    for await (const event of handle.events()) {
      events.push(event);
      if (event.type === 'interaction.requested' && event.payload.kind === 'question') {
        await handle.respond({
          requestId: event.payload.requestId,
          action: 'submit',
          answers: { [event.payload.questions[0]!.id]: 'yes' },
        });
      }
    }
    expect(events.map((event) => event.type)).toContain('interaction.resolved');
    expect(events.at(-1)?.type).toBe('run.completed');
    await expect(handle.refresh()).resolves.toMatchObject({ status: 'completed' });
  });
});
