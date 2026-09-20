import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import { AuditService } from '../src/audit/audit.service.js';
import type { CloudConfig } from '../src/config.js';
import { MemoryControlPlaneStore } from '../src/persistence/memory.store.js';

it('audit records expose only fixed fields and cannot serialize caller secrets', async () => {
  const store = new MemoryControlPlaneStore();
  const config = {
    eventRetentionSeconds: 60,
  } as CloudConfig;
  const audit = new AuditService(store, config);
  const marker = 'secret-marker-must-not-appear';
  await audit.record({
    requestId: randomUUID(),
    action: 'run.create',
    outcome: 'rejected',
    status: 400,
    errorCode: 'CONFIGURATION_INVALID',
    secret: marker,
    prompt: marker,
  } as Parameters<AuditService['record']>[0]);
  expect(JSON.stringify(store.audits)).not.toContain(marker);
  expect(Object.keys(store.audits[0]!).sort()).toEqual(
    ['action', 'errorCode', 'expiresAt', 'outcome', 'requestId', 'status', 'timestamp'].sort(),
  );
});
