import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type { HarnessAdapter } from '@yanbot-harness/adapter-api';
import { ReferenceAdapter } from '@yanbot-harness/adapter-reference';
import {
  HARNESS_PROTOCOL_VERSION,
  runRequestSchema,
  type AdapterEvent,
  type InteractionResponse,
  type Run,
} from '@yanbot-harness/contracts';
import { createManagedAdapterRun, type ManagedRunController } from '@yanbot-harness/core';
import type { RemoteRunJob } from '@yanbot-harness/cloud-queue';

import type { WorkerConfig } from './config.js';
import { InternalControlPlaneClient, InternalClientError, type WorkerWorkspace } from './internal-client.js';

export type WorkerControlPlaneClient = {
  claim(): Promise<unknown>;
  run(runId: string, attempt: number): Promise<Run>;
  workspace(runId: string, attempt: number): Promise<WorkerWorkspace>;
  heartbeat(runId: string, attempt: number): Promise<void>;
  interaction(runId: string, attempt: number, requestId: string): Promise<InteractionResponse | undefined>;
  append(runId: string, attempt: number, value: AdapterEvent): Promise<void>;
};
type ClientFactory = (grant: string) => WorkerControlPlaneClient;
type AdapterFactory = () => HarnessAdapter;

export class RunCoordinator {
  readonly #clientFactory: ClientFactory;
  readonly #adapterFactory: AdapterFactory;

  constructor(
    private readonly config: WorkerConfig,
    clientFactory?: ClientFactory,
    adapterFactory: AdapterFactory = () => new ReferenceAdapter(),
  ) {
    this.#clientFactory =
      clientFactory ?? ((grant) => new InternalControlPlaneClient(config.internalOrigin, grant, config.workerId));
    this.#adapterFactory = adapterFactory;
  }

  async process(job: RemoteRunJob): Promise<void> {
    const client = this.#clientFactory(job.executionGrant);
    await client.claim();
    const run = await client.run(job.runId, job.attempt);
    const workspace = await client.workspace(job.runId, job.attempt);
    let sequence = run.lastSequence ?? 0;
    let controller: ManagedRunController | undefined;
    let lostLease = false;
    let timedOut = false;
    let terminal = false;
    const abort = new AbortController();
    const pumps = new Set<Promise<void>>();
    const stop = async () => {
      abort.abort();
      await controller?.cancel('Remote execution lease ended.');
    };
    const heartbeat = setInterval(() => {
      void client.heartbeat(job.runId, job.attempt).catch(async () => {
        lostLease = true;
        await stop();
      });
    }, this.config.heartbeatMs);
    heartbeat.unref();
    const timeout = setTimeout(() => {
      timedOut = true;
      void stop();
    }, this.config.runTimeoutMs);
    timeout.unref();

    try {
      const cwd = workspacePath(this.config.sharedWorkspaceRoot, workspace);
      const request = {
        ...runRequestSchema.parse({
          runId: run.runId,
          sessionId: run.sessionId,
          prompt: run.prompt,
          ...(cwd === undefined ? {} : { cwd }),
          ...(run.model === undefined ? {} : { model: run.model }),
          permissionPolicy: run.permissionPolicy,
          configScopes: [],
          extensions: [],
        }),
        abortSignal: abort.signal,
      };
      controller = await createManagedAdapterRun(this.#adapterFactory(), {}, request);
      for await (const adapterEvent of controller.events) {
        if (lostLease) throw new InternalClientError(403);
        const event =
          timedOut && adapterEvent.type === 'run.cancelled'
            ? ({
                ...adapterEvent,
                type: 'run.failed',
                payload: {
                  error: { code: 'RUN_TIMEOUT', message: 'The Remote Reference Worker timed out.', retryable: false },
                },
              } satisfies AdapterEvent)
            : adapterEvent;
        await client.append(job.runId, job.attempt, event);
        sequence = event.sequence;
        if (event.type === 'interaction.requested') {
          const pump = this.#pumpInteraction(client, controller, job, event.payload.requestId, abort.signal)
            .catch(async () => {
              lostLease = true;
              await stop();
            })
            .finally(() => pumps.delete(pump));
          pumps.add(pump);
        }
        terminal = isTerminal(event);
      }
      await Promise.all(pumps);
    } catch (error) {
      if (!lostLease && !terminal) {
        await this.#appendFailure(client, run.runId, run.sessionId, job.attempt, sequence + 1, error);
      }
      if (!lostLease) throw error;
    } finally {
      clearInterval(heartbeat);
      clearTimeout(timeout);
      abort.abort();
      await controller?.dispose();
    }
  }

  async #pumpInteraction(
    client: WorkerControlPlaneClient,
    controller: ManagedRunController,
    job: RemoteRunJob,
    requestId: string,
    signal: AbortSignal,
  ): Promise<void> {
    while (!signal.aborted) {
      const response = await client.interaction(job.runId, job.attempt, requestId);
      if (response) {
        await controller.respond(response);
        return;
      }
      await delay(this.config.interactionPollMs, signal);
    }
  }

  async #appendFailure(
    client: WorkerControlPlaneClient,
    runId: string,
    sessionId: string,
    attempt: number,
    sequence: number,
    cause: unknown,
  ): Promise<void> {
    const configurationFailure =
      cause instanceof Error && cause.message === 'Git workspaces require an isolated sandbox.';
    const event: AdapterEvent = {
      protocolVersion: HARNESS_PROTOCOL_VERSION,
      eventId: randomUUID(),
      runId,
      sessionId,
      sequence,
      timestamp: new Date().toISOString(),
      type: 'run.failed',
      payload: {
        error: {
          code: configurationFailure ? 'CONFIGURATION_INVALID' : 'INTERNAL_ERROR',
          message: configurationFailure
            ? 'Git workspaces require an isolated sandbox.'
            : 'The Remote Reference Worker failed.',
          retryable: false,
        },
      },
    };
    try {
      await client.append(runId, attempt, event);
    } catch (error) {
      if (!(error instanceof InternalClientError && [403, 404, 409].includes(error.status))) throw error;
    }
  }
}

function workspacePath(root: string, workspace: WorkerWorkspace): string | undefined {
  if (workspace.source.kind === 'git-ref') throw new Error('Git workspaces require an isolated sandbox.');
  if (workspace.source.kind !== 'uploaded-snapshot' || !workspace.storageKey) return undefined;
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...workspace.storageKey.split('/'));
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error('The workspace escaped its configured root.');
  return resolved;
}

function isTerminal(event: AdapterEvent): boolean {
  return event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.cancelled';
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
