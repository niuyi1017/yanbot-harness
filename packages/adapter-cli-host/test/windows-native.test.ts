import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { createWindowsCliJobOwner, runVendorCli } from '../src/index.js';

const nativeHost = process.env.HARNESS_CLI_JOB_HOST;
const nativeTest = it.runIf(process.platform === 'win32' && Boolean(nativeHost));
const fixture = fileURLToPath(new URL('./fixtures/fake-vendor.mjs', import.meta.url));

async function assertGone(pid: number) {
  expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
  const deadline = Date.now() + 2_000;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      expect(error).toMatchObject({ code: 'ESRCH' });
      return;
    }
    if (Date.now() >= deadline) throw new Error('Job descendant remained alive.');
    await delay(25);
  }
}

nativeTest('native Job cancellation removes a detached descendant', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'native-cli-job-'));
  const pidFile = path.join(root, 'child.pid');
  const controller = new AbortController();
  try {
    await expect(
      runVendorCli({
        executablePath: process.execPath,
        args: [fixture, 'detached-child', pidFile],
        environment: {},
        processOwner: createWindowsCliJobOwner(nativeHost!),
        signal: controller.signal,
        onStdoutLine: () => controller.abort(),
      }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    await assertGone(Number(await readFile(pidFile, 'utf8')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

nativeTest(
  'native Job closes when its Node owner is killed',
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'native-cli-parent-'));
    const pidFile = path.join(root, 'child.pid');
    let holder: ChildProcess | undefined;
    try {
      holder = spawn(
        process.execPath,
        [fileURLToPath(new URL('./fixtures/job-owner-parent.mjs', import.meta.url)), nativeHost!, pidFile],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      holder.stderr!.resume();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Native parent readiness timed out.')), 5_000);
        holder!.stdout!.once('data', () => {
          clearTimeout(timer);
          resolve();
        });
        holder!.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        holder!.once('exit', () => {
          clearTimeout(timer);
          reject(new Error('Native parent exited before readiness.'));
        });
      });
      holder.kill('SIGKILL');
      await assertGone(Number(await readFile(pidFile, 'utf8')));
      await assertGone(Number(await readFile(pidFile + '.parent', 'utf8')));
    } finally {
      holder?.kill('SIGKILL');
      await rm(root, { recursive: true, force: true });
    }
  },
  15_000,
);
