import { Inject, Injectable } from '@nestjs/common';

import type { CloudConfig } from '../config.js';
import type { AuditRecord, TenantPrincipal } from '../domain.js';
import { CLOUD_CONFIG } from '../persistence/mongo.service.js';
import { CONTROL_PLANE_STORE, type ControlPlaneStore } from '../persistence/control-plane.store.js';

export type AuditInput = Pick<AuditRecord, 'requestId' | 'action' | 'outcome' | 'status'> & {
  principal?: TenantPrincipal;
  organizationId?: string;
  subjectId?: string;
  resourceType?: string;
  resourceId?: string;
  errorCode?: string;
};

@Injectable()
export class AuditService {
  readonly #store: ControlPlaneStore;
  readonly #now: () => Date;
  readonly #retentionMs: number;

  constructor(@Inject(CONTROL_PLANE_STORE) store: ControlPlaneStore, @Inject(CLOUD_CONFIG) config: CloudConfig) {
    this.#store = store;
    this.#now = () => new Date();
    this.#retentionMs = Math.max(config.eventRetentionSeconds, 86_400) * 1_000;
  }

  async record(input: AuditInput): Promise<void> {
    const timestamp = this.#now();
    await this.#store.insertAudit({
      timestamp,
      requestId: input.requestId,
      ...(input.principal === undefined
        ? {
            ...(input.organizationId === undefined ? {} : { organizationId: input.organizationId }),
            ...(input.subjectId === undefined ? {} : { subjectId: input.subjectId }),
          }
        : {
            organizationId: input.principal.organizationId,
            subjectId: input.principal.userId,
            deviceId: input.principal.deviceId,
          }),
      action: input.action,
      ...(input.resourceType === undefined ? {} : { resourceType: input.resourceType }),
      ...(input.resourceId === undefined ? {} : { resourceId: input.resourceId }),
      outcome: input.outcome,
      status: input.status,
      ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
      expiresAt: new Date(timestamp.getTime() + this.#retentionMs),
    });
  }
}
