import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import { CONTROL_PLANE_STORE, type ControlPlaneStore } from '../persistence/control-plane.store.js';

export type AdmissionReconciliation = {
  organizationId: string;
  expectedActiveRuns: number;
  actualActiveRuns: number;
  status: 'consistent' | 'drift' | 'applied' | 'conflict';
};

@Injectable()
export class AdmissionService {
  readonly #store: ControlPlaneStore;
  readonly #audit: AuditService;

  constructor(@Inject(CONTROL_PLANE_STORE) store: ControlPlaneStore, @Inject(AuditService) audit: AuditService) {
    this.#store = store;
    this.#audit = audit;
  }

  async reconcile(
    options: { limit: number; apply: boolean },
    auditRequestId: string = randomUUID(),
  ): Promise<AdmissionReconciliation[]> {
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 10_000) {
      throw new Error('Admission reconciliation limit must be an integer from 1 to 10000.');
    }
    const states = await this.#store.listAdmissionStates(options.limit + 1);
    if (states.length > options.limit) {
      throw new Error('Admission reconciliation limit was exceeded; narrow the deployment scope.');
    }
    const results: AdmissionReconciliation[] = [];
    for (const state of states) {
      const expectedActiveRuns = await this.#store.countActiveRuns(state.organizationId);
      let status: AdmissionReconciliation['status'] = expectedActiveRuns === state.activeRuns ? 'consistent' : 'drift';
      if (status === 'drift' && options.apply) {
        status = (await this.#store.reconcileAdmissionActiveRuns(
          state.organizationId,
          state.activeRuns,
          expectedActiveRuns,
          new Date(),
        ))
          ? 'applied'
          : 'conflict';
      }
      const result = {
        organizationId: state.organizationId,
        expectedActiveRuns,
        actualActiveRuns: state.activeRuns,
        status,
      };
      results.push(result);
      if (options.apply) {
        await this.#audit.record({
          requestId: auditRequestId,
          organizationId: state.organizationId,
          action: 'admission.reconcile',
          resourceType: 'organization',
          resourceId: state.organizationId,
          outcome: status === 'conflict' ? 'rejected' : 'succeeded',
          status: status === 'conflict' ? 409 : 200,
          ...(status === 'conflict' ? { errorCode: 'ADMISSION_RECONCILE_CONFLICT' } : {}),
        });
      }
    }
    return results;
  }
}
