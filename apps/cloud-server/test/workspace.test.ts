import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CloudError } from '../src/common/cloud-error.js';
import type { CloudConfig } from '../src/config.js';
import type { TenantPrincipal } from '../src/domain.js';
import { MemoryControlPlaneStore } from '../src/persistence/memory.store.js';
import { WorkspaceService } from '../src/workspaces/workspace.service.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe('Cloud workspace preparation', () => {
  it('publishes a tenant-scoped snapshot and rejects cross-tenant lookup', async () => {
    const { service, root } = await setup();
    const principal = tenant();
    const bytes = Buffer.from('content');
    const digest = createHash('sha256').update(bytes).digest('hex');
    const record = await service.prepareSnapshot(principal, {
      manifest: {
        schemaVersion: 1,
        entries: [{ path: 'index.txt', type: 'file', size: bytes.length, sha256: digest, executable: false }],
      },
      files: [{ path: 'index.txt', contentBase64: bytes.toString('base64') }],
    });
    await expect(service.requireReady(principal.organizationId, record.source)).resolves.toMatchObject({
      workspaceRef: record.workspaceRef,
    });
    await expect(service.requireReady(randomUUID(), record.source)).rejects.toBeInstanceOf(CloudError);
    await expect(
      readFile(path.join(root, principal.organizationId, record.workspaceRef, 'index.txt'), 'utf8'),
    ).resolves.toBe('content');
  });

  it('accepts only allowlisted credential-free HTTPS immutable Git sources', async () => {
    const { service } = await setup();
    const principal = tenant();
    const commit = 'a'.repeat(40);
    await expect(
      service.prepareGit(principal, { repository: 'https://github.com/example/repo.git', commit }),
    ).resolves.toMatchObject({
      source: { kind: 'git-ref', repository: 'https://github.com/example/repo.git', ref: commit },
    });
    for (const repository of [
      'http://github.com/example/repo.git',
      'https://user:secret@github.com/example/repo.git',
      'https://github.com/example/repo.git?token=secret',
      'https://127.0.0.1/repo.git',
    ]) {
      await expect(service.prepareGit(principal, { repository, commit })).rejects.toMatchObject({
        code: 'CONFIGURATION_INVALID',
      });
    }
  });

  it('maps invalid snapshots and declared resource limits to stable public errors', async () => {
    const { service } = await setup();
    const principal = tenant();
    await expect(service.prepareSnapshot(principal, { manifest: {}, files: [] })).rejects.toMatchObject({
      status: 422,
    });
    await expect(
      service.prepareSnapshot(principal, {
        manifest: {
          schemaVersion: 1,
          entries: [
            {
              path: 'large.bin',
              type: 'file',
              size: 16 * 1024 * 1024 + 1,
              sha256: 'a'.repeat(64),
              executable: false,
            },
          ],
        },
        files: [],
      }),
    ).rejects.toMatchObject({ status: 413 });
  });
});

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'yanbot-cloud-workspaces-'));
  roots.push(root);
  const store = new MemoryControlPlaneStore();
  const config: CloudConfig = {
    nodeEnv: 'test',
    host: '127.0.0.1',
    port: 0,
    trustProxy: false,
    tlsTerminated: false,
    mongodbUri: 'mongodb://unused',
    mongodbDatabase: 'test',
    tokenPepper: 'p'.repeat(32),
    workspaceRoot: root,
    accessTokenTtlSeconds: 900,
    refreshTokenTtlSeconds: 604_800,
    eventRetentionSeconds: 604_800,
    workspaceTtlSeconds: 86_400,
    gitAllowedHosts: ['github.com'],
    internalApiEnabled: false,
  };
  return { service: new WorkspaceService(store, config), store, root };
}

function tenant(): TenantPrincipal {
  return { organizationId: randomUUID(), userId: randomUUID(), deviceId: randomUUID(), roles: ['owner'] };
}
