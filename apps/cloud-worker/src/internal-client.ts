import {
  adapterEventSchema,
  interactionResponseSchema,
  runSchema,
  workspaceSourceSchema,
  type AdapterEvent,
  type InteractionResponse,
  type Run,
  type WorkspaceSource,
} from '@yanbot-harness/contracts';
import { z } from 'zod';

const claimSchema = z.object({
  organizationId: z.string().uuid(),
  runId: z.string().uuid(),
  workspaceRef: z.string().uuid(),
  attempt: z.number().int().positive(),
  actions: z.array(z.string()),
  expiresAt: z.coerce.date(),
  claimedAt: z.coerce.date().optional(),
  claimedBy: z.string().optional(),
  revokedAt: z.coerce.date().optional(),
});
const workspaceSchema = z.object({
  workspaceRef: z.string().uuid(),
  source: workspaceSourceSchema,
  storageKey: z.string().optional(),
});

export type WorkerWorkspace = { workspaceRef: string; source: WorkspaceSource; storageKey?: string };

export class InternalClientError extends Error {
  constructor(readonly status: number) {
    super(`The internal control plane request failed with status ${status}.`);
    this.name = 'InternalClientError';
  }
}

export class InternalControlPlaneClient {
  constructor(
    private readonly origin: string,
    private readonly executionGrant: string,
    private readonly workerId: string,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  async claim() {
    return claimSchema.parse(
      await this.#request('/internal/v1/execution-grants/claim', {
        method: 'POST',
        body: JSON.stringify({ workerId: this.workerId }),
      }),
    );
  }

  async run(runId: string, attempt: number): Promise<Run> {
    return runSchema.parse(await this.#request(`/internal/v1/runs/${runId}?attempt=${attempt}`));
  }

  async workspace(runId: string, attempt: number): Promise<WorkerWorkspace> {
    const value = workspaceSchema.parse(await this.#request(`/internal/v1/runs/${runId}/workspace?attempt=${attempt}`));
    return {
      workspaceRef: value.workspaceRef,
      source: value.source,
      ...(value.storageKey === undefined ? {} : { storageKey: value.storageKey }),
    };
  }

  async heartbeat(runId: string, attempt: number): Promise<void> {
    await this.#request(`/internal/v1/runs/${runId}/heartbeat?attempt=${attempt}`, {
      method: 'POST',
      body: JSON.stringify({ workerId: this.workerId }),
    });
  }

  async interaction(runId: string, attempt: number, requestId: string): Promise<InteractionResponse | undefined> {
    try {
      return interactionResponseSchema.parse(
        await this.#request(
          `/internal/v1/runs/${runId}/interactions/${encodeURIComponent(requestId)}?attempt=${attempt}`,
        ),
      );
    } catch (error) {
      if (error instanceof InternalClientError && error.status === 404) return undefined;
      throw error;
    }
  }

  async append(runId: string, attempt: number, value: AdapterEvent): Promise<void> {
    await this.#request(`/internal/v1/runs/${runId}/events?attempt=${attempt}`, {
      method: 'POST',
      body: JSON.stringify(adapterEventSchema.parse(value)),
    });
  }

  async #request(pathname: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.fetchImplementation(`${this.origin}${pathname}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.executionGrant}`,
        'x-worker-id': this.workerId,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
    });
    if (!response.ok) throw new InternalClientError(response.status);
    if (response.status === 204) return undefined;
    return response.json();
  }
}
