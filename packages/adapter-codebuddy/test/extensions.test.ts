import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AdapterExtensionSnapshot, AdapterRunInput } from '@yanbot-harness/adapter-api';
import type { AdapterEvent } from '@yanbot-harness/contracts';
import { CodeBuddyAdapter, type CodeBuddyQueryInput, type CodeBuddySdkFacade } from '../src/index.js';
import { mapMcp, prepareExtensions } from '../src/extensions.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const content = '---\nname: selected-fixture\ndescription: Fixture only\n---\nSELECTED_SKILL_CANARY';
const skill: AdapterExtensionSnapshot = {
  kind: 'skill',
  extensionId: 'selected-fixture',
  version: '1.0.0',
  source: 'bundled',
  descriptorDigest: hash('descriptor'),
  contentDigest: hash('content'),
  resource: { files: [{ path: 'SKILL.md', content, bytes: Buffer.byteLength(content), digest: hash(content) }] },
};
const mcp: Extract<AdapterExtensionSnapshot, { kind: 'mcp' }> = {
  kind: 'mcp',
  extensionId: 'mcp.fixture',
  version: '0.0.0',
  source: 'bundled',
  descriptorDigest: hash('mcp'),
  contentDigest: hash('mcp resource'),
  resource: {
    name: 'fixture',
    transport: 'stdio',
    command: 'node',
    args: ['fixture.js'],
    envCredentialRefs: { FIXTURE_KEY: 'fixture-key' },
  },
};
const context = { credentials: { CODEBUDDY_API_KEY: 'vendor-test-secret', 'fixture-key': 'mcp-test-secret' } };
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'codebuddy-extensions-'));
  roots.push(root);
  const cwd = path.join(root, 'workspace');
  await mkdir(cwd);
  const input: AdapterRunInput = {
    runId: '11111111-1111-4111-8111-111111111111',
    sessionId: '22222222-2222-4222-8222-222222222222',
    prompt: 'fixture',
    cwd,
    permissionPolicy: 'interactive',
    configScopes: ['project', 'user'],
    extensions: [skill, mcp].map(({ extensionId }) => ({ extensionId, enabled: true })),
    extensionSnapshots: [skill, mcp],
  };
  return { root, cwd, input, stateRoot: path.join(root, 'vendor-state') };
}
describe('CodeBuddy candidate extension mapping', () => {
  it('exposes explicitly experimental native execution without marking it live verified', async () => {
    const f = await fixture();
    const runtime = await new CodeBuddyAdapter({
      experimentalExtensions: true,
      extensionStateRoot: f.stateRoot,
    }).createRuntime(context);
    expect((await runtime.capabilities())['extensions.mcp']).toMatchObject({
      level: 'native',
      limits: { experimental: true, liveVerified: false },
    });
    expect((await runtime.capabilities())['extensions.skills']).toMatchObject({
      level: 'native',
      limits: { experimental: true, liveVerified: false },
    });
    await runtime.dispose();
  });
  it('keeps default capability unsupported and refuses direct ungated execution', async () => {
    const f = await fixture();
    const runtime = await new CodeBuddyAdapter().createRuntime(context);
    expect((await runtime.capabilities())['extensions.skills']?.level).toBe('unsupported');
    await expect(runtime.startRun(f.input)[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      code: 'CAPABILITY_UNSUPPORTED',
    });
  });
  it('uses credential placeholders in MCP argv config and secrets only in private child environment', () => {
    const mapped = mapMcp(mcp, context);
    expect(JSON.stringify(mapped.server)).not.toContain('mcp-test-secret');
    expect(Object.values(mapped.env)).toEqual(['mcp-test-secret']);
    expect(mapped.server.env.FIXTURE_KEY).toMatch(/^\$\{HARNESS_MCP_[A-F0-9]+\}$/);
    expect(() => mapMcp(mcp, {})).toThrow('An MCP credential binding is unresolved.');
    expect(() => mapMcp({ ...mcp, resource: { ...mcp.resource, args: ['${CODEBUDDY_API_KEY}'] } }, context)).toThrow();
  });
  it('preserves private vendor session state while deleting only selected run projections and releasing the lease', async () => {
    const f = await fixture();
    const projected = await prepareExtensions(f.input, context, f.stateRoot);
    const session = projected.env.CODEBUDDY_CONFIG_DIR!;
    const skills = projected.env.CODEBUDDY_SESSION_SKILL_DIRS!;
    expect(await readFile(path.join(skills, 'selected-fixture', 'SKILL.md'), 'utf8')).toBe(content);
    expect(projected.env.CODEBUDDY_BUILTIN_SKILLS_DIR).toBe('');
    await mkdir(path.join(session, 'projects'));
    await writeFile(path.join(session, 'projects', 'fixture.json'), '{}');
    await expect(prepareExtensions(f.input, context, f.stateRoot)).rejects.toThrow('already in use');
    await projected.dispose();
    await projected.dispose();
    await expect(readFile(path.join(skills, 'selected-fixture', 'SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(session, 'projects', 'fixture.json'), 'utf8')).toBe('{}');
    const resumed = await prepareExtensions(
      { ...f.input, adapterSessionId: 'vendor-fixture-session' },
      context,
      f.stateRoot,
    );
    expect(resumed.env.CODEBUDDY_CONFIG_DIR).toBe(session);
    expect(resumed.env.CODEBUDDY_SESSION_SKILL_DIRS).not.toBe(skills);
    await resumed.dispose();
  });
  it('rejects ambient project configuration, invalid snapshot digest, and traversal without leaving lease/projection', async () => {
    const f = await fixture();
    await mkdir(path.join(f.cwd, '.codebuddy'));
    await expect(prepareExtensions(f.input, context, f.stateRoot)).rejects.toThrow('ambient');
    await rm(path.join(f.cwd, '.codebuddy'), { recursive: true });
    const invalidSkill = {
      ...skill,
      resource: { files: [{ path: '../escape', content, bytes: Buffer.byteLength(content), digest: hash(content) }] },
    };
    await expect(
      prepareExtensions({ ...f.input, extensionSnapshots: [invalidSkill, mcp] }, context, f.stateRoot),
    ).rejects.toThrow('could not be prepared');
    expect(await readdir(path.join(f.stateRoot, f.input.sessionId))).toEqual([]);
  });
  it.each(['complete', 'query-throw', 'cancel'] as const)(
    'maps strict isolated options and cleans projections on %s',
    async (kind) => {
      const f = await fixture();
      let captured: CodeBuddyQueryInput | undefined;
      const sdk: CodeBuddySdkFacade = {
        query(input) {
          captured = input;
          if (kind === 'query-throw') throw new Error('fixture failure mcp-test-secret');
          return {
            async *[Symbol.asyncIterator]() {
              yield { type: 'system', subtype: 'init', session_id: 'fixture-session' };
              if (kind === 'cancel') {
                await input.canUseTool('mcp__mcp.fixture__read', {}, { toolUseID: 'permission-fixture' });
              } else {
                yield {
                  type: 'assistant',
                  message: {
                    content: [{ type: 'text', text: 'mcp-test-secret ' + input.env.CODEBUDDY_SESSION_SKILL_DIRS }],
                  },
                };
                yield { type: 'result', is_error: false };
              }
            },
            async interrupt() {},
          };
        },
        async listModels() {
          return [];
        },
      };
      const runtime = await new CodeBuddyAdapter({
        sdk,
        allowUnverifiedExtensions: true,
        extensionStateRoot: f.stateRoot,
        shutdownGraceMs: 20,
      }).createRuntime(context);
      const events: AdapterEvent[] = [];
      for await (const event of runtime.startRun(f.input)) {
        events.push(event);
        if (event.type === 'interaction.requested') await runtime.cancel({ runId: f.input.runId });
      }
      expect(captured).toMatchObject({
        settingSources: [],
        strictMcpConfig: true,
        tools: ['Read', 'Skill', 'AskUserQuestion'],
      });
      expect(JSON.stringify(captured?.mcpServers)).not.toContain('mcp-test-secret');
      expect(JSON.stringify(events)).not.toContain('mcp-test-secret');
      expect(JSON.stringify(events)).not.toContain(f.root);
      expect(events.at(-1)?.type).toBe(
        kind === 'complete' ? 'run.completed' : kind === 'cancel' ? 'run.cancelled' : 'run.failed',
      );
      expect(
        (await readdir(path.join(f.stateRoot, f.input.sessionId))).filter(
          (item) => item.startsWith('run-') || item === '.extension-lease',
        ),
      ).toEqual([]);
      await runtime.dispose();
    },
  );
});
