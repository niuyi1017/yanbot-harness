import { randomUUID } from 'node:crypto';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAdapterConformance } from '@yanbot-harness/adapter-kit';
import { runRequestSchema } from '@yanbot-harness/contracts';
import { ClaudeCodeCliAdapter } from '../dist/index.js';

let root: string;
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'claude-adapter-test-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
const request = () =>
  runRequestSchema.parse({
    runId: randomUUID(),
    sessionId: randomUUID(),
    prompt: 'test',
    permissionPolicy: 'read-only',
  });
async function adapter(scenario: string) {
  const executablePath = path.join(root, `vendor-${scenario}.mjs`);
  await writeFile(
    executablePath,
    `#!${process.execPath}
import {writeFileSync} from 'node:fs';
if (process.argv.includes('--version')) { console.log('${scenario === 'version' ? '9.9.9' : '2.1.284'} (Claude Code)'); }
else {
 let input=''; process.stdin.on('data', c => input+=c); process.stdin.on('end', () => {
  if(input !== 'test' || process.argv.includes('test')) process.exit(19);
  writeFileSync(process.env.HOME + '/private-marker', 'private');
  writeFileSync(${JSON.stringify(path.join(root, 'last-home'))}, process.env.HOME);
  const sid = 'vendor-session';
  const emit = value => console.log(JSON.stringify(value));
  emit({type:'system',subtype:'init',session_id:sid,tools:[],claude_code_version:'2.1.284'});
  if ('${scenario}' === 'wait') { setInterval(()=>{},1000); return; }
  if ('${scenario}' === 'auth') emit({type:'assistant',session_id:sid,error:'authentication_failed',is_api_error_message:true,message:{content:[{type:'text',text:'secret-marker'}]}});
  else emit({type:'assistant',session_id:sid,message:{content:[{type:'text',text:process.env.ANTHROPIC_API_KEY || 'OK'}]}});
  if ('${scenario}' !== 'missing') emit({type:'result',session_id:sid,subtype:'success',is_error:'${scenario}'==='auth',usage:{input_tokens:1,output_tokens:2},total_cost_usd:0.001,num_turns:1});
  if ('${scenario}' === 'nonzero' || '${scenario}' === 'auth') process.exitCode=1;
 });
}
`,
    { mode: 0o700 },
  );
  return new ClaudeCodeCliAdapter({ executablePath, apiKey: 'secret-marker' });
}

describe.skipIf(process.platform === 'win32')('Claude Code fixture Sidecar conformance', () => {
  it('runs through the real Wrapper/Host, redacts credentials and cleans private files', async () => {
    const before = new Set(await readdir(tmpdir()));
    const report = await runAdapterConformance({
      adapter: await adapter('normal'),
      request: request(),
      forbiddenValues: ['secret-marker'],
    });
    expect(report.events.at(-1)?.type).toBe('run.completed');
    expect(report.events.find((e) => e.type === 'assistant.delta')?.payload).toMatchObject({ text: '[redacted]' });
    const leftovers = (await readdir(tmpdir())).filter(
      (name) => name.startsWith('harness-credentials-') && !before.has(name),
    );
    expect(leftovers).toEqual([]);
    const home = await readFile(path.join(root, 'last-home'), 'utf8');
    await expect(access(home)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each([
    ['auth', 'AUTHENTICATION_FAILED'],
    ['missing', 'HARNESS_PROTOCOL_ERROR'],
    ['nonzero', 'HARNESS_FAILED'],
  ])('fails %s without false completion', async (scenario, code) => {
    const report = await runAdapterConformance({
      adapter: await adapter(scenario!),
      request: request(),
      forbiddenValues: ['secret-marker'],
    });
    expect(report.events.at(-1)).toMatchObject({ type: 'run.failed', payload: { error: { code } } });
  });
  it('cancels the active CLI and emits one terminal after cleanup', async () => {
    const report = await runAdapterConformance({
      adapter: await adapter('wait'),
      request: request(),
      cancelAfterEvents: 2,
    });
    expect(report.events.at(-1)?.type).toBe('run.cancelled');
  });
  it('rejects an unsupported version at probe', async () => {
    expect(await (await adapter('version')).probe({})).toMatchObject({ available: false });
  });
  it('rejects interactive runs explicitly', async () => {
    const report = await runAdapterConformance({
      adapter: await adapter('normal'),
      request: { ...request(), permissionPolicy: 'interactive' },
    });
    expect(report.events.at(-1)).toMatchObject({
      type: 'run.failed',
      payload: { error: { code: 'CAPABILITY_UNSUPPORTED' } },
    });
  });
});
