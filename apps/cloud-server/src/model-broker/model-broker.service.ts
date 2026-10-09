import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Optional, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { CloudError, permissionDenied, resourceNotFound } from '../common/cloud-error.js';
import type { CloudConfig } from '../config.js';
import type { RunRecord } from '../domain.js';
import { ExecutionGrantService } from '../execution-grants/execution-grant.service.js';
import { CONTROL_PLANE_STORE, type ControlPlaneStore } from '../persistence/control-plane.store.js';
import { CLOUD_CONFIG } from '../persistence/mongo.service.js';
import { forwardModel, MODEL_TRANSPORT, type ModelStream, type ModelTransport } from './forward.js';
import {
  brokerPoliciesSchema,
  readPrivateFile,
  readModelKey,
  validateModelRequest,
  type BrokerPolicy,
} from './policy.js';

@Injectable()
export class ModelBrokerService implements OnModuleInit, OnModuleDestroy {
  #policies: BrokerPolicy[] = [];
  readonly #active = new Set<AbortController>();
  readonly #transport: ModelTransport;
  constructor(
    @Inject(CLOUD_CONFIG) private readonly config: CloudConfig,
    @Inject(CONTROL_PLANE_STORE) private readonly store: ControlPlaneStore,
    @Inject(ExecutionGrantService) private readonly grants: ExecutionGrantService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Optional() @Inject(MODEL_TRANSPORT) transport?: ModelTransport,
  ) {
    if (transport && config.nodeEnv !== 'test') throw new Error('Model transport overrides are test-only.');
    this.#transport = transport ?? fetch;
  }
  async onModuleInit(): Promise<void> {
    if (!this.config.modelBrokerPoliciesFile) return;
    if (
      this.config.nodeEnv === 'production' ||
      !this.config.internalApiEnabled ||
      (!this.config.experimentalClaudeCli && !this.config.experimentalCodeBuddy)
    )
      throw new Error('The model broker requires an experimental internal vendor deployment.');
    try {
      this.#policies = brokerPoliciesSchema.parse(
        JSON.parse(await readPrivateFile(this.config.modelBrokerPoliciesFile, 256 * 1024)),
      ).policies;
      if (
        this.#policies.some((p) =>
          p.adapterId === 'cn.tencent.codebuddy'
            ? !this.config.experimentalCodeBuddy
            : !this.config.experimentalClaudeCli,
        )
      )
        throw new Error('Adapter not enabled.');
    } catch {
      throw new Error('The private model broker policy file is invalid.');
    }
  }
  onModuleDestroy(): void {
    for (const active of this.#active) active.abort();
    this.#active.clear();
    this.#policies = [];
  }
  async invoke(input: {
    grant: string;
    runId: string;
    attempt: number;
    workerId: string | undefined;
    body: unknown;
    signal: AbortSignal;
    requestId?: string;
  }): Promise<ModelStream> {
    if (!this.#policies.length) throw resourceNotFound();
    const auditRequestId = input.requestId ?? randomUUID();
    let run: RunRecord | undefined;
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, input.signal]);
    let upstream: ModelStream | undefined;
    const close = () => {
      abort.abort();
      upstream?.close();
      this.#active.delete(abort);
    };
    const record = async (outcome: 'succeeded' | 'rejected' | 'failed', status: number, action: string) => {
      await this.audit.record({
        requestId: auditRequestId,
        action,
        outcome,
        status,
        ...(run ? { organizationId: run.organizationId, resourceType: 'run', resourceId: run.runId } : {}),
      });
    };
    try {
      run = await this.grants.authorizeModel(input.grant, input.runId, input.attempt, input.workerId);
      const policy = this.#policies.find(
        (policy) => policy.organizationId === run!.organizationId && policy.adapterId === run!.value.adapterId,
      );
      if (!policy) throw permissionDenied();
      const body = validateModelRequest(input.body, policy, run.value.model?.modelId);
      if (this.#active.size >= 16)
        throw new CloudError(429, 'HARNESS_FAILED', 'The model broker is at capacity.', true);
      this.#active.add(abort);
      const apiKey = await readModelKey(policy.apiKeyFile);
      await this.store.transaction(async () => {
        signal.throwIfAborted();
        const current = await this.grants.authorizeModel(input.grant, input.runId, input.attempt, input.workerId);
        if (!(await this.store.reserveModelRequest(current.organizationId, current.runId, policy.maxRequests)))
          throw new CloudError(429, 'HARNESS_FAILED', 'The Run model request limit was reached.');
        await record('succeeded', 201, 'model.request.reserve');
      });
      upstream = await forwardModel({
        body,
        apiKey,
        grant: input.grant,
        signal,
        transport: this.#transport,
        authorize: () => this.grants.authorizeModel(input.grant, input.runId, input.attempt, input.workerId),
      });
      const stream = upstream;
      async function* output() {
        let completed = false;
        try {
          yield* stream.body;
          completed = true;
        } finally {
          close();
          await record(completed ? 'succeeded' : 'failed', completed ? 200 : 502, 'model.request.finish');
        }
      }
      return { contentType: stream.contentType, body: output(), signal: stream.signal, close };
    } catch (error) {
      close();
      const safe =
        error instanceof CloudError ? error : new CloudError(502, 'HARNESS_FAILED', 'The model request failed.');
      await record(safe.status < 500 ? 'rejected' : 'failed', safe.status, 'model.request.reject');
      throw safe;
    }
  }
}
