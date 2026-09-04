import { describe, expect, it } from 'vitest';

import { initializeRequestSchema, sidecarRequestSchema } from '../src/index.js';

describe('sidecar protocol schemas', () => {
  it('round-trips initialization as JSONL-safe data', () => {
    const request = initializeRequestSchema.parse({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '1.0.0', clientName: 'yanbot-harness', clientVersion: '0.1.0' },
    });
    expect(sidecarRequestSchema.parse(JSON.parse(JSON.stringify(request)))).toEqual(request);
  });

  it('rejects incompatible protocol versions at the schema boundary', () => {
    expect(() =>
      initializeRequestSchema.parse({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2.0.0', clientName: 'client', clientVersion: '0.1.0' },
      }),
    ).toThrow();
  });
});
