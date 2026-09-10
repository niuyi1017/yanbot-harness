import { execFile } from 'node:child_process';
import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { ReferenceAdapter } from '@yanbot-harness/adapter-reference';
import { startLocalRuntime, type LocalRuntimeHandle } from '@yanbot-harness/local-runtime';
import { createTemporaryStateRoot } from '@yanbot-harness/testing';
import { afterEach, describe, expect, it } from 'vitest';

const executeFile = promisify(execFile);
const runtimes: LocalRuntimeHandle[] = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('CLI process boundary', () => {
  it('owns an installed Runtime for one command and cleans its temporary state', async () => {
    const temporary = await createTemporaryStateRoot('yanbot-cli-managed-');
    cleanups.push(temporary.cleanup);
    const workspace = path.join(temporary.path, 'workspace');
    const managedTemp = path.join(temporary.path, 'managed-temp');
    await Promise.all([mkdir(workspace), mkdir(managedTemp)]);
    const cli = path.resolve(import.meta.dirname, '../dist/main.js');
    const runtimeEntry = path.resolve(import.meta.dirname, '../../local-runtime/dist/main.js');

    const result = await executeFile(
      process.execPath,
      [cli, 'run', 'managed runtime client', '--managed-runtime', runtimeEntry, '--json', '--log-level', 'silent'],
      {
        cwd: workspace,
        env: {
          ...process.env,
          TMPDIR: managedTemp,
          YANBOT_HARNESS_ADAPTER: 'reference',
        },
      },
    );

    expect(result.stdout).toContain('"type":"run.completed"');
    expect(result.stderr).toBe('');
    expect(await readdir(managedTemp)).toEqual([]);
  });

  it('cleans an owned Runtime when a JSONL run requires interaction', async () => {
    const temporary = await createTemporaryStateRoot('yanbot-cli-managed-interaction-');
    cleanups.push(temporary.cleanup);
    const workspace = path.join(temporary.path, 'workspace');
    const managedTemp = path.join(temporary.path, 'managed-temp');
    await Promise.all([mkdir(workspace), mkdir(managedTemp)]);
    const cli = path.resolve(import.meta.dirname, '../dist/main.js');
    const runtimeEntry = path.resolve(import.meta.dirname, '../../local-runtime/dist/main.js');

    const failure = await executeFile(
      process.execPath,
      [cli, 'run', 'managed interaction client', '--managed-runtime', runtimeEntry, '--json', '--log-level', 'silent'],
      {
        cwd: workspace,
        env: {
          ...process.env,
          TMPDIR: managedTemp,
          YANBOT_HARNESS_ADAPTER: 'reference',
          YANBOT_HARNESS_REFERENCE_SCENARIO: 'question',
        },
      },
    ).catch((error: unknown) => error);

    const result = failure as { code?: unknown; stdout?: unknown; stderr?: unknown };
    expect(result.code).toBe(11);
    expect(String(result.stdout)).toContain('"type":"interaction.requested"');
    expect(await readdir(managedTemp)).toEqual([]);
  });

  it('invokes the Reference Adapter through daemon HTTP/SSE in text and JSONL modes', async () => {
    const temporary = await createTemporaryStateRoot('yanbot-cli-e2e-');
    cleanups.push(temporary.cleanup);
    const workspace = path.join(temporary.path, 'workspace');
    const descriptorPath = path.join(temporary.path, 'runtime.json');
    await mkdir(workspace);
    const runtime = await startLocalRuntime({
      stateRoot: path.join(temporary.path, 'state'),
      runtimeDescriptorPath: descriptorPath,
      adapters: [
        new ReferenceAdapter({ scenario: { kind: 'text', chunks: ['Third-party ', 'simulation complete.'] } }),
      ],
    });
    runtimes.push(runtime);
    const cli = path.resolve(import.meta.dirname, '../dist/main.js');

    const text = await executeFile(
      process.execPath,
      [cli, 'run', 'simulate text client', '--descriptor', descriptorPath, '--log-level', 'silent'],
      {
        cwd: workspace,
        env: { ...process.env },
      },
    );
    expect(text.stdout).toBe('Third-party simulation complete.\n');
    expect(text.stderr).toBe('');

    const json = await executeFile(
      process.execPath,
      [cli, 'run', 'simulate JSONL client', '--descriptor', descriptorPath, '--json', '--log-level', 'silent'],
      {
        cwd: workspace,
        env: { ...process.env },
      },
    );
    const records = json.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type?: string; run?: { sessionId?: string } });
    expect(records[0]?.type).toBe('cli.run-created');
    expect(records.map((record) => record.type)).toContain('assistant.delta');
    expect(records.at(-1)?.type).toBe('run.completed');
    expect(json.stderr).toBe('');

    const sessionId = records[0]?.run?.sessionId;
    expect(sessionId).toBeTypeOf('string');
    const resumed = await executeFile(
      process.execPath,
      [
        cli,
        'run',
        'resume the external session',
        '--descriptor',
        descriptorPath,
        '--session',
        sessionId!,
        '--resume',
        '--json',
        '--log-level',
        'silent',
      ],
      { cwd: workspace, env: { ...process.env } },
    );
    expect(resumed.stdout).toContain(`"sessionId":"${sessionId}"`);
    expect(resumed.stdout).toContain('"type":"run.completed"');
  });

  it('maps a normalized Adapter failure to a stable process exit code', async () => {
    const temporary = await createTemporaryStateRoot('yanbot-cli-failure-');
    cleanups.push(temporary.cleanup);
    const workspace = path.join(temporary.path, 'workspace');
    const descriptorPath = path.join(temporary.path, 'runtime.json');
    await mkdir(workspace);
    const runtime = await startLocalRuntime({
      stateRoot: path.join(temporary.path, 'state'),
      runtimeDescriptorPath: descriptorPath,
      adapters: [new ReferenceAdapter({ scenario: { kind: 'failure', code: 'AUTHENTICATION_FAILED' } })],
    });
    runtimes.push(runtime);
    const cli = path.resolve(import.meta.dirname, '../dist/main.js');

    const failure = await executeFile(
      process.execPath,
      [cli, 'run', 'fail predictably', '--descriptor', descriptorPath, '--json', '--log-level', 'silent'],
      { cwd: workspace, env: { ...process.env } },
    ).catch((error: unknown) => error);
    const result = failure as { code?: unknown; stdout?: unknown; stderr?: unknown };
    expect(String(result.stderr)).toBe('Reference failure.\n');
    expect({ code: result.code, stdout: String(result.stdout), stderr: String(result.stderr) }).toMatchObject({
      code: 20,
      stdout: expect.stringContaining('"type":"run.failed"'),
    });
  });
});
