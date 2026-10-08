import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DockerSandboxAdapter, reapUnstartedContainers } from '../src/index.js';

const roots: string[] = [];
const cid = 'a'.repeat(64);
const activeCid = 'b'.repeat(64);
const manifest = {
  protocolVersion: '1.0.0' as const,
  adapterId: 'cn.yanbot.reference',
  adapterVersion: '0.1.0',
  displayName: 'Reference',
  harness: { name: 'Reference' },
  runtimeKinds: ['in-process' as const],
};
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(scenario: string) {
  const root = await mkdtemp(path.join(tmpdir(), 'sandbox-lifecycle-'));
  roots.push(root);
  const workspacePath = path.join(root, 'workspace');
  await mkdir(workspacePath);
  const log = path.join(root, 'commands.jsonl');
  const dockerPath = path.join(root, 'docker.mjs');
  await writeFile(
    dockerPath,
    `#!${process.execPath}
import {appendFileSync} from 'node:fs';
const args=process.argv.slice(2);appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');
if(args[0]==='info') console.log('linux');
else if(args[0]==='create') { if('${scenario}'==='bad-create') {console.error('secret-marker');process.exit(1);} console.log('${cid}'); }
else if(args[0]==='start') process.exit(1);
else if(args[0]==='ps') {
 if('${scenario}'==='cleanup-failure') console.log('${cid}');
 else if('${scenario}'==='reaper') console.log('${cid}\\n${activeCid}');
}
else if(args[0]==='inspect') console.log(JSON.stringify([{Id:args[1],Name:'/harness-sandbox-00000000-0000-4000-8000-000000000000',Created:new Date(Date.now()-120000).toISOString(),State:{Status:args[1]==='${cid}'?'created':'running'},Config:{Labels:{'io.yanbot.harness.sandbox':'1'}}}]));
`,
    { mode: 0o700 },
  );
  return { deployment: { dockerPath, image: `sha256:${cid}`, snapshotRoot: root, workspacePath }, log };
}
describe.skipIf(process.platform === 'win32')(
  'Docker command failure boundaries (fixtures, not containment evidence)',
  () => {
    it('does not execute Docker for rejected deployment settings', async () => {
      const { deployment, log } = await fixture('normal');
      await expect(
        new DockerSandboxAdapter({ ...deployment, image: 'mutable:tag' }, manifest).probe({}),
      ).rejects.toMatchObject({ code: 'HARNESS_FAILED' });
      await expect(access(log)).rejects.toMatchObject({ code: 'ENOENT' });
    });
    it('does not reflect raw create diagnostics', async () => {
      const { deployment } = await fixture('bad-create');
      const error = await new DockerSandboxAdapter(deployment, manifest).probe({}).catch((error) => error);
      expect(String(error)).not.toContain('secret-marker');
      expect(error.code).toBe('HARNESS_FAILED');
    });
    it('fails when container removal cannot be verified', async () => {
      const { deployment } = await fixture('cleanup-failure');
      await expect(new DockerSandboxAdapter(deployment, manifest).probe({})).rejects.toMatchObject({
        code: 'HARNESS_FAILED',
      });
    });
    it('reaps only old created containers without force despite stale listing', async () => {
      const { deployment, log } = await fixture('reaper');
      expect(await reapUnstartedContainers(deployment.dockerPath)).toBe(1);
      const commands = (await readFile(log, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(commands.filter((args) => args[0] === 'rm')).toEqual([['rm', cid]]);
    });
  },
);
