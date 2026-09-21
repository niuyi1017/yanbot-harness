import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { ReferenceAdapter } from '@yanbot-harness/adapter-reference';
import type { HarnessAdapter } from '@yanbot-harness/adapter-api';
import type { AdapterEvent } from '@yanbot-harness/contracts';
import { LocalAdapterService, createEnvironmentContextProvider } from '../src/adapters.js';
import { FileLocalStateStore } from '../src/local-state-store.js';
import { LocalEventHub } from '../src/event-hub.js';
import { RunSupervisor } from '../src/run-supervisor.js';
import { WorkspaceGrantRegistry } from '../src/workspace-grants.js';
import { loadRegisteredExtensions } from '../src/extension-registration.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(credential = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'runtime-extensions-'));
  roots.push(root);
  const registry = path.join(root, 'extensions');
  await mkdir(path.join(registry, 'skills', 'sample'), { recursive: true });
  await writeFile(
    path.join(registry, 'skills', 'sample', 'SKILL.md'),
    '---\nname: sample\nversion: 1.0.0\n---\nPRIVATE_SKILL_CONTENT',
  );
  await writeFile(
    path.join(registry, 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        sample: {
          command: 'node',
          args: ['will-never-execute.js'],
          ...(credential ? { envCredentialRefs: { API_KEY: 'fixture-key' } } : {}),
        },
      },
    }),
  );
  const start = async (adapter: HarnessAdapter = new ReferenceAdapter()) => {
    const store = new FileLocalStateStore({ stateRoot: path.join(root, 'state') });
    await store.initialize();
    const grants = new WorkspaceGrantRegistry();
    const grant = await grants.issue(root);
    const supervisor = new RunSupervisor({
      store,
      eventHub: new LocalEventHub(store),
      workspaceGrants: grants,
      adapters: new LocalAdapterService({ adapters: [adapter] }),
      extensions: await loadRegisteredExtensions(registry),
      interactionTimeoutMs: 1000,
    });
    return { store, supervisor, grant: grant.grant };
  };
  return { root, registry, start };
}
function request(grant: string) {
  return {
    prompt: 'extensions',
    workspaceGrant: grant,
    permissionPolicy: 'interactive' as const,
    configScopes: [],
    extensions: [
      { extensionId: 'sample', enabled: true },
      { extensionId: 'mcp.sample', enabled: true },
    ],
    resume: false,
  };
}
async function run(supervisor: RunSupervisor, runId: string, action: 'allow' | 'deny' | 'cancel' = 'allow') {
  const events: AdapterEvent[] = [];
  for await (const event of supervisor.events(runId)) {
    events.push(event);
    if (event.type === 'interaction.requested') {
      if (action === 'cancel') await supervisor.cancelRun(runId);
      else {
        const response = { requestId: event.payload.requestId, action };
        await supervisor.respondToInteraction(response);
        await supervisor.respondToInteraction(response);
      }
    }
  }
  return events;
}
describe('local extension execution seam', () => {
  it('passes immutable resources through core, persists only digest identity, resumes after restart, rejects changed resources', async () => {
    const f = await fixture();
    const first = await f.start();
    const session = await first.supervisor.createSession({ adapterId: 'cn.yanbot.reference' });
    const initial = await first.supervisor.createRun(session.sessionId, request(first.grant));
    const events = await run(first.supervisor, initial.run.runId);
    expect(events.at(-1)?.type).toBe('run.completed');
    expect(
      events.some(
        (event) => event.type === 'assistant.delta' && event.payload.text.startsWith('Reference Skill sample@1.0.0:'),
      ),
    ).toBe(true);
    expect(events.filter((event) => event.type === 'tool.completed')).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain('PRIVATE_SKILL_CONTENT');
    expect(JSON.stringify(events)).not.toContain(f.root);
    const pin = await readFile(path.join(f.root, 'state', 'sessions', session.sessionId, 'extension-pin.json'), 'utf8');
    expect(pin).not.toContain(f.root);
    expect(pin).not.toContain('PRIVATE_SKILL_CONTENT');
    const restarted = await f.start();
    const resumed = await restarted.supervisor.createRun(session.sessionId, {
      ...request(restarted.grant),
      resume: true,
    });
    expect((await run(restarted.supervisor, resumed.run.runId)).at(-1)?.type).toBe('run.completed');
    await writeFile(path.join(f.registry, 'skills', 'sample', 'guide.md'), 'new resource');
    await expect(
      restarted.supervisor.createRun(session.sessionId, { ...request(restarted.grant), resume: true }),
    ).rejects.toMatchObject({ code: 'CONFIGURATION_INVALID' });
    await expect(
      restarted.supervisor.createRun(session.sessionId, { ...request(restarted.grant), extensions: [], resume: true }),
    ).rejects.toMatchObject({ code: 'CONFIGURATION_INVALID' });
  });
  it.each(['deny', 'cancel'] as const)(
    'converges extension %s to one terminal without tool execution',
    async (action) => {
      const f = await fixture();
      const active = await f.start();
      const session = await active.supervisor.createSession({ adapterId: 'cn.yanbot.reference' });
      const created = await active.supervisor.createRun(session.sessionId, request(active.grant));
      const events = await run(active.supervisor, created.run.runId, action);
      expect(events.at(-1)?.type).toBe(action === 'cancel' ? 'run.cancelled' : 'run.failed');
      expect(events.filter((event) => event.type === 'tool.completed')).toHaveLength(0);
      expect(
        events.filter((event) => ['run.completed', 'run.failed', 'run.cancelled'].includes(event.type)),
      ).toHaveLength(1);
    },
  );
  it('rejects missing credentials before adapter run execution', async () => {
    const f = await fixture(true);
    const active = await f.start();
    const session = await active.supervisor.createSession({ adapterId: 'cn.yanbot.reference' });
    const created = await active.supervisor.createRun(session.sessionId, request(active.grant));
    const events = await run(active.supervisor, created.run.runId);
    expect(events.map((event) => event.type)).toEqual(['run.started', 'run.failed']);
    expect(events.at(-1)).toMatchObject({ payload: { error: { code: 'CONFIGURATION_INVALID' } } });
  });
  it('rejects unknown registration roots without leaking local paths', async () => {
    await expect(loadRegisteredExtensions('/not-a-real-extension-root')).rejects.toThrow(
      'The trusted extension directory is invalid.',
    );
    expect(await loadRegisteredExtensions(undefined)).toEqual([]);
  });
  it('binds only allowlisted environment credentials and redacts event values before public delivery', async () => {
    const adapter: HarnessAdapter = {
      ...new ReferenceAdapter(),
      manifest: new ReferenceAdapter().manifest,
      probe: async () => ({ available: true }),
      createRuntime: async () =>
        new ReferenceAdapter({ scenario: { kind: 'text', chunks: ['fixture-secret-value'] } }).createRuntime(),
    };
    const service = new LocalAdapterService({
      adapters: [adapter],
      contextProvider: createEnvironmentContextProvider({
        allowedEnvironmentKeys: ['FIXTURE_KEY'],
        environment: { FIXTURE_KEY: 'fixture-secret-value' },
      }),
    });
    const controller = await service.startRun(
      adapter.manifest.adapterId,
      {
        runId: '11111111-1111-4111-8111-111111111111',
        sessionId: '22222222-2222-4222-8222-222222222222',
        prompt: 'fixture',
        permissionPolicy: 'interactive',
        extensions: [],
        configScopes: [],
      },
      { adapterConfig: {}, credentialRefs: { key: 'env:FIXTURE_KEY' } },
    );
    const events: AdapterEvent[] = [];
    for await (const event of controller.events) events.push(event);
    expect(JSON.stringify(events)).not.toContain('fixture-secret-value');
    expect(JSON.stringify(events)).toContain('[REDACTED]');
  });
});
