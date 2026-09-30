import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Readable } from 'node:stream';
import { expect, it } from 'vitest';
import { observeCliJob } from '../src/windows-job-owner.js';

const fixture = fileURLToPath(new URL('./fixtures/fake-job-host.mjs', import.meta.url));
function observe(scenario: string) {
  const child = spawn(process.execPath, [fixture, scenario], { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
  child.stdout!.resume();
  child.stderr!.resume();
  return observeCliJob(child, child.stdio[3] as Readable, child.stdin!);
}

it('accepts exactly one matching empty-Job proof', async () => {
  const owner = observe('normal');
  await owner.terminate(2_000);
  await owner.terminate(2_000);
});
it.each(['missing', 'wrong-host', 'nonempty', 'duplicate', 'wrong-exit'])(
  'rejects %s native ownership proof',
  async (scenario) => {
    await expect(observe(scenario).terminate(2_000)).rejects.toMatchObject({ code: 'CLEANUP_UNVERIFIED' });
  },
);
