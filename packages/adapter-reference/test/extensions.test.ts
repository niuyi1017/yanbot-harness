import { describe, expect, it } from 'vitest';
import type { AdapterExtensionSnapshot, AdapterRunInput } from '@yanbot-harness/adapter-api';
import { adapterEventSchema, type AdapterEvent } from '@yanbot-harness/contracts';
import { ReferenceAdapter } from '../src/index.js';

const snapshots: readonly AdapterExtensionSnapshot[] = [
  {
    extensionId: 'sample',
    version: '1.0.0',
    source: 'bundled',
    descriptorDigest: 'a'.repeat(64),
    contentDigest: 'b'.repeat(64),
    kind: 'skill',
    resource: { files: [{ path: 'SKILL.md', content: 'SECRET_CANARY', bytes: 13, digest: 'c'.repeat(64) }] },
  },
  {
    extensionId: 'mcp.sample',
    version: '0.0.0',
    source: 'bundled',
    descriptorDigest: 'd'.repeat(64),
    contentDigest: 'e'.repeat(64),
    kind: 'mcp',
    resource: {
      name: 'sample',
      transport: 'stdio',
      command: '/private/SECRET_COMMAND',
      args: [],
      envCredentialRefs: {},
    },
  },
];
const input: AdapterRunInput = {
  runId: '11111111-1111-4111-8111-111111111111',
  sessionId: '22222222-2222-4222-8222-222222222222',
  prompt: 'fixture',
  permissionPolicy: 'interactive',
  configScopes: [],
  extensions: snapshots.map(({ extensionId }) => ({ extensionId, enabled: true })),
  extensionSnapshots: snapshots,
};
describe('reference extension conformance', () => {
  it('proves selected digest markers, permission and question while never interpreting source/commands', async () => {
    const runtime = await new ReferenceAdapter({
      scenario: { kind: 'question', prompt: 'Continue?', answerResult: 'complete' },
    }).createRuntime();
    const events: AdapterEvent[] = [];
    for await (const raw of runtime.startRun(input)) {
      const event = adapterEventSchema.parse(raw);
      events.push(event);
      if (event.type === 'interaction.requested') {
        await runtime.respondToInteraction?.(
          event.payload.kind === 'permission'
            ? { requestId: event.payload.requestId, action: 'allow' }
            : {
                requestId: event.payload.requestId,
                action: 'submit',
                answers: { [event.payload.questions[0]!.id]: 'yes' },
              },
        );
      }
    }
    expect(events.map(({ sequence }) => sequence)).toEqual(events.map((_, index) => index + 1));
    expect(events.filter(({ type }) => type === 'interaction.resolved')).toHaveLength(2);
    expect(events.at(-1)?.type).toBe('run.completed');
    expect(JSON.stringify(events)).not.toContain('SECRET_CANARY');
    expect(JSON.stringify(events)).not.toContain('SECRET_COMMAND');
    expect((await runtime.capabilities())['extensions.mcp']?.level).toBe('emulated');
    await runtime.dispose();
  });
  it('cancels an in-progress fixture tool with a failed tool event and exactly one terminal', async () => {
    const runtime = await new ReferenceAdapter().createRuntime();
    const events: AdapterEvent[] = [];
    for await (const raw of runtime.startRun(input)) {
      const event = adapterEventSchema.parse(raw);
      events.push(event);
      if (event.type === 'interaction.requested')
        await runtime.respondToInteraction?.({ requestId: event.payload.requestId, action: 'allow' });
      if (event.type === 'tool.started') await runtime.cancel({ runId: input.runId });
    }
    expect(events.slice(-2).map(({ type }) => type)).toEqual(['tool.failed', 'run.cancelled']);
    expect(events.filter(({ type }) => type === 'run.cancelled')).toHaveLength(1);
    await runtime.dispose();
  });
  it('fails a selection without the matching private snapshot', async () => {
    const runtime = await new ReferenceAdapter().createRuntime();
    const events: AdapterEvent[] = [];
    for await (const event of runtime.startRun({ ...input, extensionSnapshots: [] })) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: 'run.failed', payload: { error: { code: 'CONFIGURATION_INVALID' } } });
    await runtime.dispose();
  });
});
