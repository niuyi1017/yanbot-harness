import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

import { z } from 'zod';

import { SidecarClient, SidecarError, type SidecarClientOptions } from './client.js';

export type SidecarLaunch = {
  executablePath: string;
  args: readonly string[];
  workingDirectory?: string;
  environment: Readonly<Record<string, string>>;
};

/** A platform owner must bind termination to the child it spawned, not reopen a reusable PID. */
export interface SidecarProcessOwner {
  spawn(launch: SidecarLaunch): ChildProcess;
  terminate(child: ChildProcess, timeoutMs: number): Promise<void>;
}

export type SidecarSupervisorOptions = SidecarLaunch &
  SidecarClientOptions & {
    clientName: string;
    clientVersion: string;
    expectedAdapterId?: string;
    expectedAdapterVersion?: string;
    shutdownTimeoutMs?: number;
    processOwner?: SidecarProcessOwner;
  };

/** Owns a single Wrapper process and its protocol client. */
export class SidecarSupervisor {
  readonly client: SidecarClient;
  readonly #child: ChildProcess;
  readonly #owner: SidecarProcessOwner;
  readonly #shutdownTimeoutMs: number;
  #closing: Promise<void> | undefined;

  private constructor(child: ChildProcess, owner: SidecarProcessOwner, options: SidecarSupervisorOptions) {
    this.#child = child;
    this.#owner = owner;
    this.#shutdownTimeoutMs = boundedTimeout(options.shutdownTimeoutMs ?? 5_000);
    this.client = new SidecarClient(child, {
      ...(options.maxLineBytes === undefined ? {} : { maxLineBytes: options.maxLineBytes }),
      ...(options.maxStderrBytes === undefined ? {} : { maxStderrBytes: options.maxStderrBytes }),
      ...(options.maxPendingRequests === undefined ? {} : { maxPendingRequests: options.maxPendingRequests }),
      ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
      ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
      onFatal: (error) => {
        try {
          options.onFatal?.(error);
        } finally {
          void this.dispose().catch(() => undefined);
        }
      },
    });
  }

  static async start(options: SidecarSupervisorOptions): Promise<SidecarSupervisor> {
    validateLaunch(options);
    // taskkill by PID cannot establish ownership after a race with process exit. A Windows Job owner is mandatory.
    if (process.platform === 'win32' && options.processOwner === undefined) {
      throw new SidecarError('PROTOCOL_ERROR', 'Windows Sidecar requires a native process-tree owner.');
    }
    const owner = options.processOwner ?? posixProcessOwner;
    const child = owner.spawn(options);
    let supervisor: SidecarSupervisor;
    try {
      supervisor = new SidecarSupervisor(child, owner, options);
    } catch (error) {
      await owner.terminate(child, 5_000).catch(() => undefined);
      throw error;
    }
    try {
      await supervisor.client.initialize(
        options.clientName,
        options.clientVersion,
        options.expectedAdapterId,
        options.expectedAdapterVersion,
      );
      return supervisor;
    } catch (error) {
      await supervisor.dispose().catch(() => undefined);
      throw error;
    }
  }

  get pid(): number | undefined {
    return this.#child.pid;
  }

  dispose(): Promise<void> {
    this.#closing ??= this.#stop();
    return this.#closing;
  }

  async #stop(): Promise<void> {
    try {
      let shutdownAcknowledged = false;
      let terminatedByOwner = false;
      if (!this.client.failed && this.#child.exitCode === null && this.#child.signalCode === null) {
        shutdownAcknowledged = await this.client
          .request('shutdown', {}, z.object({}), Math.min(1_000, this.#shutdownTimeoutMs))
          .then(
            () => true,
            () => false,
          );
      }
      if (await closesWithin(this.client.waitForClose(), Math.min(1_000, this.#shutdownTimeoutMs))) {
        if (!shutdownAcknowledged) {
          throw new SidecarError('CLEANUP_UNVERIFIED', 'Sidecar exited without a verified shutdown.');
        }
      } else {
        await this.#owner.terminate(this.#child, this.#shutdownTimeoutMs);
        terminatedByOwner = true;
      }
      if (!(await closesWithin(this.client.waitForClose(), this.#shutdownTimeoutMs))) {
        throw new SidecarError('PROCESS_EXIT', 'Sidecar did not exit after termination.');
      }
      if (
        shutdownAcknowledged &&
        !terminatedByOwner &&
        (this.#child.exitCode !== 0 || this.#child.signalCode !== null)
      ) {
        throw new SidecarError('PROCESS_EXIT', 'Sidecar exited abnormally after shutdown.');
      }
    } finally {
      this.client.dispose();
    }
  }
}

const posixProcessOwner: SidecarProcessOwner = {
  spawn(launch) {
    return spawn(launch.executablePath, [...launch.args], {
      cwd: launch.workingDirectory,
      env: { ...launch.environment },
      shell: false,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  },
  async terminate(child, timeoutMs) {
    const pid = child.pid;
    if (pid === undefined || child.exitCode !== null || child.signalCode !== null) {
      throw new SidecarError('PROCESS_EXIT', 'Sidecar process-tree ownership cannot be verified after exit.');
    }
    try {
      process.kill(-pid, 'SIGTERM');
    } catch (error) {
      if (!missingProcess(error)) throw error;
    }
    if (await closesWithin(closed(child), Math.max(10, Math.floor(timeoutMs * 0.6)))) return;
    try {
      process.kill(-pid, 'SIGKILL');
    } catch (error) {
      if (!missingProcess(error)) throw error;
    }
    if (!(await closesWithin(closed(child), Math.max(10, Math.floor(timeoutMs * 0.4))))) {
      throw new SidecarError('PROCESS_EXIT', 'Sidecar process tree did not stop.');
    }
  },
};

function validateLaunch(launch: SidecarSupervisorOptions): void {
  if (!path.isAbsolute(launch.executablePath) || launch.executablePath.includes('\0')) {
    throw new SidecarError('PROTOCOL_ERROR', 'Sidecar executable must be an absolute path.');
  }
  if (launch.workingDirectory !== undefined && !path.isAbsolute(launch.workingDirectory)) {
    throw new SidecarError('PROTOCOL_ERROR', 'Sidecar working directory must be an absolute path.');
  }
  if (
    launch.args.some((arg) => typeof arg !== 'string' || arg.includes('\0')) ||
    Object.entries(launch.environment).some(
      ([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || value.includes('\0'),
    )
  ) {
    throw new SidecarError('PROTOCOL_ERROR', 'Invalid Sidecar argument or environment.');
  }
  if (!launch.clientName.trim() || !launch.clientVersion.trim()) {
    throw new SidecarError('PROTOCOL_ERROR', 'Sidecar client identity is required.');
  }
}

function boundedTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 100 || value > 30_000) {
    throw new SidecarError('RESOURCE_LIMIT', 'Invalid Sidecar shutdown timeout.');
  }
  return value;
}

function missingProcess(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH';
}

function closed(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('close', () => resolve()));
}

async function closesWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
