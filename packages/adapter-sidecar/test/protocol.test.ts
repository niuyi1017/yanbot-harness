import { describe, expect, it } from 'vitest';

import { initializeRequestSchema, sidecarRequestSchema, startRunRequestSchema } from '../src/index.js';

describe('sidecar protocol schemas', () => {
  it('rejects private snapshots and extension selections instead of silently stripping them', () => {
    const request = {
      jsonrpc: '2.0',
      id: 1,
      method: 'startRun',
      params: {
        runId: '11111111-1111-4111-8111-111111111111',
        sessionId: '22222222-2222-4222-8222-222222222222',
        prompt: 'fixture',
        permissionPolicy: 'interactive',
        configScopes: [],
        extensions: [],
      },
    };
    expect(startRunRequestSchema.safeParse(request).success).toBe(true);
    expect(
      startRunRequestSchema.safeParse({ ...request, params: { ...request.params, extensionSnapshots: [] } }).success,
    ).toBe(false);
    expect(
      startRunRequestSchema.safeParse({
        ...request,
        params: { ...request.params, extensions: [{ extensionId: 'fixture', enabled: true }] },
      }).success,
    ).toBe(false);
  });
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
