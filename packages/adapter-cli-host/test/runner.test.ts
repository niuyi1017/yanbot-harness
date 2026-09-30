import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { describe, expect, it } from 'vitest';

import { buildAllowedEnvironment, createWindowsCliJobOwner, probeVendorVersion, runVendorCli } from '../src/index.js';

const fixture = fileURLToPath(new URL('./fixtures/fake-vendor.mjs', import.meta.url));
const nativeHost = process.env.HARNESS_CLI_JOB_HOST;

function launch(scenario: string, extraArgs: readonly string[] = []) {
  return {
    executablePath: process.execPath,
    args: [fixture, scenario, ...extraArgs],
    environment: {},
    ...(process.platform === 'win32' && nativeHost ? { processOwner: createWindowsCliJobOwner(nativeHost) } : {}),
  };
}

describe.skipIf(process.platform === 'win32' && !nativeHost)('generic vendor CLI host', () => {
  it('copies only explicit allowed environment variables', async () => {
    const environment = buildAllowedEnvironment({ TEST_ALLOWED: 'yes', SECRET_MARKER: 'secret-marker' }, [
      'TEST_ALLOWED',
    ]);
    const lines: string[] = [];
    await runVendorCli({
      ...launch('environment'),
      environment,
      onStdoutLine: (line) => {
        lines.push(line);
      },
    });
    expect(JSON.parse(lines[0] ?? '[]')).toContain('TEST_ALLOWED');
    expect(JSON.parse(lines[0] ?? '[]')).not.toContain('SECRET_MARKER');
  });

  it('reads split UTF-8 and CRLF lines without mixing stderr', async () => {
    const lines: string[] = [];
    const result = await runVendorCli({
      ...launch('normal'),
      onStdoutLine: (line) => {
        lines.push(line);
      },
    });
    expect(lines).toEqual(['α', 'beta']);
    expect(result).toMatchObject({ exitCode: 0, stdoutLines: 2 });
  });

  it('uses the bounded runner for a version probe', async () => {
    expect(await probeVendorVersion(launch('version'))).toBe('fake-vendor 1.2.3');
  });

  it('writes bounded UTF-8 input and rejects oversized input before launch', async () => {
    const lines: string[] = [];
    const stdinText = 'α'.repeat(128 * 1024);
    await runVendorCli({
      ...launch('stdin-count'),
      stdinText,
      onStdoutLine: (line) => {
        lines.push(line);
      },
    });
    expect(lines).toEqual([String(Buffer.byteLength(stdinText))]);
    await expect(
      runVendorCli({ ...launch('stdin-count'), stdinText: 'x'.repeat(4 * 1024 * 1024 + 1) }),
    ).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
  });

  it('closes stdin for commands waiting for EOF', async () => {
    const lines: string[] = [];
    await runVendorCli({
      ...launch('stdin-eof'),
      onStdoutLine: (line) => {
        lines.push(line);
      },
    });
    expect(lines).toEqual(['eof']);
  });

  it.each([
    ['long-line', 'RESOURCE_LIMIT'],
    ['many-lines', 'RESOURCE_LIMIT'],
    ['stderr-flood', 'RESOURCE_LIMIT'],
    ['invalid-utf8', 'PARSER_ERROR'],
    ['exit4', 'NONZERO_EXIT'],
  ])('fails closed for %s', async (scenario, code) => {
    await expect(
      runVendorCli({ ...launch(scenario), maxLineBytes: 1_024, maxStdoutBytes: 1_024, maxStderrBytes: 1_024 }),
    ).rejects.toMatchObject({ code });
  });

  it('does not echo raw vendor output when the wrapper parser rejects it', async () => {
    const error = await runVendorCli({
      ...launch('noise'),
      onStdoutLine: () => {
        throw new Error('secret-marker');
      },
    }).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: 'PARSER_ERROR' });
    expect(String(error)).not.toContain('secret-marker');
  });

  it('cancels an owned process and its in-group child', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'cli-host-test-'));
    const childFile = path.join(directory, 'child.pid');
    const controller = new AbortController();
    try {
      await expect(
        runVendorCli({
          ...launch('child', [childFile]),
          signal: controller.signal,
          onStdoutLine: (line) => {
            if (line === 'started') controller.abort();
          },
          shutdownTimeoutMs: 500,
        }),
      ).rejects.toMatchObject({ code: 'CANCELLED' });
      const pid = Number(await readFile(childFile, 'utf8'));
      expect(Number.isSafeInteger(pid)).toBe(true);
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('times out a live vendor process that stops emitting stdout', async () => {
    await expect(runVendorCli({ ...launch('stall'), idleTimeoutMs: 200 })).rejects.toMatchObject({
      code: 'IDLE_TIMEOUT',
    });
  });

  it('finalizes an injected owner after a successful process exit', async () => {
    let finalized = 0;
    await runVendorCli({
      ...launch('version'),
      processOwner: {
        spawn: (options) =>
          spawn(options.executablePath, [...options.args], {
            env: { ...options.environment },
            stdio: ['pipe', 'pipe', 'pipe'],
          }),
        terminate: async (child) => {
          expect(child.exitCode).toBe(0);
          finalized += 1;
        },
      },
    });
    expect(finalized).toBe(1);
  });

  it.skipIf(process.platform === 'win32')('reports a remaining process group after the leader has exited', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'cli-host-orphan-'));
    const childFile = path.join(directory, 'child.pid');
    try {
      await expect(runVendorCli({ ...launch('orphan', [childFile]), shutdownTimeoutMs: 100 })).rejects.toMatchObject({
        code: 'CLEANUP_UNVERIFIED',
      });
    } finally {
      // This fixture exits by itself; only probe its PID to avoid signalling a reused process.
      const pid = Number(await readFile(childFile, 'utf8'));
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        try {
          process.kill(pid, 0);
        } catch {
          break;
        }
        await delay(25);
      }
      expect(() => process.kill(pid, 0)).toThrow();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('escalates cancellation when the owned leader ignores TERM', async () => {
    const controller = new AbortController();
    await expect(
      runVendorCli({
        ...launch('ignore-term'),
        signal: controller.signal,
        shutdownTimeoutMs: 200,
        onStdoutLine: () => {
          controller.abort();
        },
      }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('enforces the total run deadline independently of the idle deadline', async () => {
    await expect(runVendorCli({ ...launch('stall'), runTimeoutMs: 200, idleTimeoutMs: 2_000 })).rejects.toMatchObject({
      code: 'RUN_TIMEOUT',
    });
  });

  it('stops delivering buffered output after cancellation', async () => {
    const controller = new AbortController();
    const lines: string[] = [];
    await expect(
      runVendorCli({
        ...launch('many-lines'),
        signal: controller.signal,
        onStdoutLine: async (line) => {
          lines.push(line);
          controller.abort();
          await Promise.resolve();
        },
      }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(lines).toHaveLength(1);
  });

  it('waits for the parser before delivering another line', async () => {
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lines: string[] = [];
    const result = runVendorCli({
      ...launch('normal'),
      onStdoutLine: async (line) => {
        lines.push(line);
        if (lines.length === 1) {
          entered();
          await gate;
        }
      },
    });
    try {
      await waiting;
      expect(lines).toEqual(['α']);
    } finally {
      release();
    }
    await result;
    expect(lines).toEqual(['α', 'beta']);
  });

  it('reports an unavailable executable without leaking its path', async () => {
    const error = await runVendorCli({ ...launch('version'), executablePath: '/does-not-exist/secret-marker' }).catch(
      (failure: unknown) => failure,
    );
    expect(error).toMatchObject({ code: 'SPAWN_ERROR' });
    expect(String(error)).not.toContain('secret-marker');
  });

  it('rejects invalid launch paths before spawn', async () => {
    await expect(runVendorCli({ ...launch('version'), executablePath: 'node' })).rejects.toMatchObject({
      code: 'INVALID_LAUNCH',
    });
  });
});

it.runIf(process.platform === 'win32')('requires a native process owner on Windows', async () => {
  await expect(runVendorCli({ executablePath: process.execPath, args: [], environment: {} })).rejects.toMatchObject({
    code: 'INVALID_LAUNCH',
  });
});
