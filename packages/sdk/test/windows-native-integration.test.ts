import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { startManagedRuntime } from '../src/managed-runtime.js';
import { HARNESS_RELEASE_VERSION } from '@yanbot-harness/contracts';

const native = process.env.HARNESS_NATIVE_JOB_HOST ? path.resolve(process.env.HARNESS_NATIVE_JOB_HOST) : undefined;
const windows = it.skipIf(process.platform !== 'win32' || !native);
const repository = path.resolve(import.meta.dirname, '../../..');
async function until<T>(read: () => Promise<T>, timeout = 10000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      const result = await read();
      if (result) return result;
    } catch {
      /* Waiting for an owned fixture. */
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Owned process observation timed out.');
}
async function request(endpoint: { port: number }, token: string, method = 'GET') {
  try {
    const response = await fetch('http://127.0.0.1:' + endpoint.port, {
      method,
      headers: { authorization: token },
      signal: AbortSignal.timeout(500),
    });
    await response.arrayBuffer();
    return response.ok;
  } catch {
    return false;
  }
}

it('required containment rejects compatibility paths before launching anything', async () => {
  await expect(startManagedRuntime({ executablePath: '/not-a-runtime', requireContainment: true })).rejects.toThrow(
    'CONTAINMENT_UNAVAILABLE',
  );
});
for (const scenario of ['close', 'runtime-crash', 'sdk-parent-crash']) {
  windows(
    'native SDK reclaims detached descendants after ' + scenario,
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'harness-native-sdk-'));
      const endpointFile = path.join(root, 'worker.json');
      const token = randomUUID();
      const entry = path.join(root, 'entry.mjs');
      await writeFile(
        entry,
        `
      import ${JSON.stringify(pathToFileURL(path.join(repository, 'apps/local-runtime/dist/main.js')).href)};
      import {spawn} from 'node:child_process'; import {existsSync} from 'node:fs';
      spawn(process.execPath,[${JSON.stringify(path.join(repository, 'scripts/fixtures/job-owned-worker.mjs'))},${JSON.stringify(endpointFile)},${JSON.stringify(token)}],{detached:true,stdio:'ignore'}).unref();
      setInterval(()=>{if(existsSync(${JSON.stringify(path.join(root, 'crash-now'))}))process.kill(process.pid,'SIGKILL');},25).unref();
    `,
      );
      const descriptor = {
        entryPath: entry,
        runtimeVersion: HARNESS_RELEASE_VERSION,
        protocolVersion: '1.0.0',
        managedProtocolVersion: 1 as const,
        containment: { kind: 'windows-job-v1' as const, executablePath: native! },
      };
      let handle: Awaited<ReturnType<typeof startManagedRuntime>> | undefined;
      let parent: ChildProcess | undefined;
      let endpoint: { port: number } | undefined;
      try {
        if (scenario === 'sdk-parent-crash') {
          const holder = path.join(root, 'holder.mjs');
          await writeFile(
            holder,
            `
          import {startManagedRuntime} from ${JSON.stringify(pathToFileURL(path.join(repository, 'packages/sdk/dist/index.js')).href)};
          import {writeFile} from 'node:fs/promises';
          const handle=await startManagedRuntime({reference:true,requireContainment:true,startupTimeoutMs:30000,runtimeResolver:async()=>(${JSON.stringify(descriptor)})});
          await writeFile(${JSON.stringify(path.join(root, 'ready'))},'ready');
          setTimeout(async()=>{await handle.close();process.exit(0);},30000);
        `,
          );
          parent = spawn(process.execPath, [holder], { stdio: 'ignore' });
          await until(() => readFile(path.join(root, 'ready'), 'utf8'), 30000);
        } else {
          handle = await startManagedRuntime({
            reference: true,
            requireContainment: true,
            startupTimeoutMs: 30000,
            runtimeResolver: async () => descriptor,
          });
          await handle.client.health();
        }
        endpoint = await until(async () => JSON.parse(await readFile(endpointFile, 'utf8')) as { port: number });
        expect(await request(endpoint, token)).toBe(true);
        if (scenario === 'sdk-parent-crash') parent!.kill('SIGKILL');
        else if (scenario === 'runtime-crash') await writeFile(path.join(root, 'crash-now'), 'crash');
        else await handle!.close();
        await until(async () => !(await request(endpoint!, token)), 10000);
      } finally {
        await handle?.close().catch(() => undefined);
        if (parent && parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL');
        if (endpoint) await request(endpoint, token, 'POST');
      }
    },
    45000,
  );
}
