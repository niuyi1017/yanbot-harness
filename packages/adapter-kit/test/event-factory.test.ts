import { describe, expect, it } from 'vitest';

import { AdapterEventFactory } from '../src/index.js';

describe('AdapterEventFactory', () => {
  it('creates validated, monotonic envelopes', () => {
    let id = 0;
    const factory = new AdapterEventFactory({
      runId: '11111111-1111-4111-8111-111111111111',
      sessionId: '22222222-2222-4222-8222-222222222222',
      now: () => new Date('2026-01-01T00:00:00.000Z'),
      generateId: () => `33333333-3333-4333-8333-${String(++id).padStart(12, '0')}`,
    });

    const started = factory.create('run.started', { adapterId: 'cn.yanbot.reference' });
    const completed = factory.create('run.completed', {});

    expect(started.sequence).toBe(1);
    expect(completed.sequence).toBe(2);
  });
});
