import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { HarnessClient } from './client.js';
import { readRuntimeDescriptor } from './daemon.js';
import { HarnessSdkError } from './transport.js';

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const MIN_TIMEOUT_MS = 100;
const MAX_STARTUP_TIMEOUT_MS = 120_000;
const MAX_SHUTDOWN_TIMEOUT_MS = 30_000;

export type StartManagedRuntimeOptions = {
  executablePath?: string;
  environment?: Readonly<Record<string, string | undefined>>;
  stateRoot?: string;
  reference?: boolean;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  fetch?: typeof fetch;
};

export type ManagedRuntimeHandle = {
  readonly client: HarnessClient;
  readonly origin: string;
  readonly pid: number;
  readonly descriptorPath: string;
  close(): Promise<void>;
};

type ChildOutcome =
  | { kind: 'exit'; code: number | null; signal: NodeJS.Signals | null }
  | { kind: 'error'; error: Error };

export async function startManagedRuntime(options: StartManagedRuntimeOptions = {}): Promise<ManagedRuntimeHandle> {
  const environment = options.environment ?? process.env;
  const executablePath = path.resolve(
    options.executablePath ?? environment.YANBOT_HARNESS_RUNTIME_PATH ?? missingRuntimePath(),
  );
  await validateExecutable(executablePath);
  const startupTimeoutMs = boundedTimeout(
    options.startupTimeoutMs,
    DEFAULT_STARTUP_TIMEOUT_MS,
    MAX_STARTUP_TIMEOUT_MS,
    'startupTimeoutMs',
  );
  const shutdownTimeoutMs = boundedTimeout(
    options.shutdownTimeoutMs,
    DEFAULT_SHUTDOWN_TIMEOUT_MS,
    MAX_SHUTDOWN_TIMEOUT_MS,
    'shutdownTimeoutMs',
  );
  const ownsStateRoot = options.stateRoot === undefined;
  const stateRoot = ownsStateRoot
    ? await mkdtemp(path.join(tmpdir(), 'yanbot-harness-managed-'))
    : path.resolve(options.stateRoot!);
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const descriptorPath = path.join(stateRoot, 'runtime.json');
  await assertDescriptorAbsent(descriptorPath);

  const { command, arguments: executableArguments } = invocationFor(executablePath);
  const child = spawn(command, [...executableArguments, ...(options.reference ? ['--reference'] : [])], {
    env: compactEnvironment({ ...environment, YANBOT_HARNESS_STATE_DIR: stateRoot }),
    stdio: 'ignore',
    windowsHide: true,
  });
  const outcome = observeChild(child);

  try {
    const descriptor = await waitForDescriptor({
      child,
      outcome,
      descriptorPath,
      environment,
      timeoutMs: startupTimeoutMs,
    });
    if (descriptor.pid !== child.pid) {
      throw new HarnessSdkError('protocol', 'The managed Runtime descriptor belongs to an unexpected process.');
    }
    const client = new HarnessClient({
      origin: descriptor.origin,
      accessToken: descriptor.accessToken,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
    await client.health();

    let closePromise: Promise<void> | undefined;
    return {
      client,
      origin: descriptor.origin,
      pid: descriptor.pid,
      descriptorPath,
      close() {
        closePromise ??= closeManagedRuntime({
          child,
          outcome,
          shutdownTimeoutMs,
          descriptorPath,
          instanceId: descriptor.instanceId,
          ownedStateRoot: ownsStateRoot ? stateRoot : undefined,
        });
        return closePromise;
      },
    };
  } catch (error) {
    await terminateOwnedChild(child, outcome, shutdownTimeoutMs).catch(() => undefined);
    if (ownsStateRoot) await rm(stateRoot, { recursive: true, force: true });
    if (error instanceof HarnessSdkError) throw error;
    throw new HarnessSdkError('runtime', 'The managed Runtime failed to start.', { cause: error });
  }
}

async function waitForDescriptor(options: {
  child: ChildProcess;
  outcome: Promise<ChildOutcome>;
  descriptorPath: string;
  environment: Readonly<Record<string, string | undefined>>;
  timeoutMs: number;
}) {
  const deadline = Date.now() + options.timeoutMs;
  let settledOutcome: ChildOutcome | undefined;
  void options.outcome.then((value) => {
    settledOutcome = value;
  });

  while (Date.now() < deadline) {
    if (settledOutcome) throw childOutcomeError(settledOutcome);
    if (await isFile(options.descriptorPath)) {
      return readRuntimeDescriptor({
        descriptorPath: options.descriptorPath,
        environment: options.environment,
      });
    }
    await delay(Math.min(50, Math.max(1, deadline - Date.now())));
  }

  if (settledOutcome) throw childOutcomeError(settledOutcome);
  if (options.child.exitCode !== null || options.child.signalCode !== null) {
    throw childOutcomeError(await options.outcome);
  }
  throw new HarnessSdkError('runtime', 'The managed Runtime did not become ready before the startup timeout.');
}

async function closeManagedRuntime(options: {
  child: ChildProcess;
  outcome: Promise<ChildOutcome>;
  shutdownTimeoutMs: number;
  descriptorPath: string;
  instanceId: string;
  ownedStateRoot: string | undefined;
}): Promise<void> {
  try {
    await terminateOwnedChild(options.child, options.outcome, options.shutdownTimeoutMs);
  } finally {
    await removeOwnedDescriptor(options.descriptorPath, options.instanceId);
    if (options.ownedStateRoot) await rm(options.ownedStateRoot, { recursive: true, force: true });
  }
}

async function terminateOwnedChild(
  child: ChildProcess,
  outcome: Promise<ChildOutcome>,
  shutdownTimeoutMs: number,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  if (await settlesWithin(outcome, shutdownTimeoutMs)) return;
  child.kill('SIGKILL');
  if (!(await settlesWithin(outcome, shutdownTimeoutMs))) {
    throw new HarnessSdkError('runtime', 'The managed Runtime did not exit after forced termination.');
  }
}

function observeChild(child: ChildProcess): Promise<ChildOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: ChildOutcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    child.once('error', (error) => finish({ kind: 'error', error }));
    child.once('exit', (code, signal) => finish({ kind: 'exit', code, signal }));
  });
}

function childOutcomeError(outcome: ChildOutcome): HarnessSdkError {
  if (outcome.kind === 'error') {
    return new HarnessSdkError('runtime', 'The managed Runtime process could not be started.', {
      cause: outcome.error,
    });
  }
  const detail = outcome.signal === null ? `exit code ${outcome.code ?? 'unknown'}` : `signal ${outcome.signal}`;
  return new HarnessSdkError('runtime', `The managed Runtime exited before it became ready (${detail}).`);
}

async function validateExecutable(file: string): Promise<void> {
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
  } catch (error) {
    throw new HarnessSdkError('runtime', 'The managed Runtime executable could not be found.', { cause: error });
  }
}

async function assertDescriptorAbsent(file: string): Promise<void> {
  try {
    await stat(file);
  } catch (error) {
    if (isMissing(error)) return;
    throw new HarnessSdkError('runtime', 'The managed Runtime state directory could not be inspected.', {
      cause: error,
    });
  }
  throw new HarnessSdkError(
    'runtime',
    'The managed Runtime state directory already contains a descriptor. Use a dedicated state directory.',
  );
}

async function removeOwnedDescriptor(file: string, instanceId: string): Promise<void> {
  try {
    const value = JSON.parse(await readFile(file, 'utf8')) as { instanceId?: unknown };
    if (value.instanceId === instanceId) await rm(file, { force: true });
  } catch (error) {
    if (!isMissing(error)) {
      throw new HarnessSdkError('runtime', 'The managed Runtime descriptor could not be cleaned up.', {
        cause: error,
      });
    }
  }
}

function invocationFor(executablePath: string): { command: string; arguments: string[] } {
  return /\.[cm]?js$/iu.test(executablePath)
    ? { command: process.execPath, arguments: [executablePath] }
    : { command: executablePath, arguments: [] };
}

function compactEnvironment(environment: Readonly<Record<string, string | undefined>>): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function boundedTimeout(value: number | undefined, fallback: number, maximum: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < MIN_TIMEOUT_MS || resolved > maximum) {
    throw new HarnessSdkError('request', `${name} must be between ${MIN_TIMEOUT_MS} and ${maximum} milliseconds.`);
  }
  return Math.floor(resolved);
}

async function settlesWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function missingRuntimePath(): never {
  throw new HarnessSdkError(
    'runtime',
    'A managed Runtime executable is required. Set executablePath or YANBOT_HARNESS_RUNTIME_PATH.',
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
