import { createHash, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';

import { Inject, Injectable } from '@nestjs/common';
import {
  WORKSPACE_SNAPSHOT_LIMITS,
  WorkspaceSnapshotError,
  validateWorkspacePayload,
  writeWorkspaceSnapshot,
} from '@yanbot-harness/workspace-snapshot';
import { z } from 'zod';

import { invalidConfiguration, resourceNotFound, workspaceLimitExceeded } from '../common/cloud-error.js';
import type { CloudConfig } from '../config.js';
import type { TenantPrincipal, WorkspaceRecord } from '../domain.js';
import { CONTROL_PLANE_STORE, type ControlPlaneStore } from '../persistence/control-plane.store.js';
import { CLOUD_CONFIG } from '../persistence/mongo.service.js';

const snapshotInputSchema = z.object({ manifest: z.unknown(), files: z.unknown() }).strict();
const gitInputSchema = z
  .object({ repository: z.string().trim().min(1).max(2_048), commit: z.string().regex(/^[a-f0-9]{40}$/u) })
  .strict();

@Injectable()
export class WorkspaceService {
  readonly #store: ControlPlaneStore;
  readonly #config: CloudConfig;
  readonly #now: () => Date;
  readonly #generateId: () => string;

  constructor(@Inject(CONTROL_PLANE_STORE) store: ControlPlaneStore, @Inject(CLOUD_CONFIG) config: CloudConfig) {
    this.#store = store;
    this.#config = config;
    this.#now = () => new Date();
    this.#generateId = randomUUID;
  }

  async prepareSnapshot(principal: TenantPrincipal, value: unknown): Promise<WorkspaceRecord> {
    const input = snapshotInputSchema.parse(value);
    this.#assertSnapshotLimits(input.manifest);
    let payload: ReturnType<typeof validateWorkspacePayload>;
    try {
      payload = validateWorkspacePayload(input.manifest, input.files);
    } catch (error) {
      if (error instanceof WorkspaceSnapshotError) throw invalidConfiguration('The workspace snapshot is invalid.');
      throw error;
    }
    const workspaceRef = this.#generateId();
    const storageKey = `${principal.organizationId}/${workspaceRef}`;
    const destination = this.#storagePath(storageKey);
    await writeWorkspaceSnapshot(destination, payload);
    const now = this.#now();
    const record: WorkspaceRecord = {
      organizationId: principal.organizationId,
      userId: principal.userId,
      workspaceRef,
      source: { kind: 'uploaded-snapshot', uploadId: workspaceRef, digest: payload.digest },
      digest: payload.digest,
      storageKey,
      status: 'ready',
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.#config.workspaceTtlSeconds * 1_000),
    };
    try {
      await this.#store.insertWorkspace(record);
      return record;
    } catch (error) {
      await rm(destination, { recursive: true, force: true });
      throw error;
    }
  }

  async prepareGit(principal: TenantPrincipal, value: unknown): Promise<WorkspaceRecord> {
    const input = gitInputSchema.parse(value);
    const repository = this.#normalizeGitRepository(input.repository);
    const now = this.#now();
    const workspaceRef = this.#generateId();
    const digest = `sha256:${createHash('sha256').update(`${repository}\n${input.commit}\n`).digest('hex')}`;
    const record: WorkspaceRecord = {
      organizationId: principal.organizationId,
      userId: principal.userId,
      workspaceRef,
      source: { kind: 'git-ref', repository, ref: input.commit },
      digest,
      status: 'ready',
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.#config.workspaceTtlSeconds * 1_000),
    };
    await this.#store.insertWorkspace(record);
    return record;
  }

  async requireReady(organizationId: string, source: unknown): Promise<WorkspaceRecord> {
    if (typeof source !== 'object' || source === null || !('kind' in source)) throw resourceNotFound();
    const value = source as { kind?: unknown; uploadId?: unknown; repository?: unknown; ref?: unknown };
    const record =
      value.kind === 'uploaded-snapshot' && typeof value.uploadId === 'string'
        ? await this.#store.findWorkspace(organizationId, value.uploadId)
        : value.kind === 'git-ref' && typeof value.repository === 'string' && typeof value.ref === 'string'
          ? await this.#store.findWorkspaceBySource(organizationId, {
              kind: 'git-ref',
              repository: value.repository,
              ref: value.ref,
            })
          : undefined;
    if (!record || record.status !== 'ready' || record.expiresAt <= this.#now()) throw resourceNotFound();
    if (JSON.stringify(record.source) !== JSON.stringify(source)) throw resourceNotFound();
    return record;
  }

  async cleanupExpired(limit = 100): Promise<number> {
    const records = await this.#store.listExpiredWorkspaces(this.#now(), limit);
    let cleaned = 0;
    for (const record of records) {
      if (!(await this.#store.markWorkspaceDeleted(record.organizationId, record.workspaceRef))) continue;
      if (record.storageKey) await rm(this.#storagePath(record.storageKey), { recursive: true, force: true });
      cleaned += 1;
    }
    return cleaned;
  }

  #normalizeGitRepository(value: string): string {
    if (this.#config.gitAllowedHosts.length === 0) throw invalidConfiguration('Git workspace sources are not enabled.');
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw invalidConfiguration('The Git workspace source is invalid.');
    }
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.port && url.port !== '443') ||
      !this.#config.gitAllowedHosts.includes(url.hostname.toLocaleLowerCase('en-US'))
    ) {
      throw invalidConfiguration('The Git workspace source is invalid.');
    }
    url.port = '';
    return url.toString();
  }

  #assertSnapshotLimits(manifest: unknown): void {
    if (typeof manifest !== 'object' || manifest === null || !('entries' in manifest)) return;
    const entries = (manifest as { entries?: unknown }).entries;
    if (!Array.isArray(entries)) return;
    if (entries.length > WORKSPACE_SNAPSHOT_LIMITS.entries) throw workspaceLimitExceeded();
    let total = 0;
    for (const entry of entries) {
      if (typeof entry !== 'object' || entry === null || !('size' in entry) || typeof entry.size !== 'number') continue;
      if (entry.size > WORKSPACE_SNAPSHOT_LIMITS.fileBytes) throw workspaceLimitExceeded();
      total += Math.max(0, entry.size);
      if (total > WORKSPACE_SNAPSHOT_LIMITS.totalBytes) throw workspaceLimitExceeded();
    }
  }

  #storagePath(storageKey: string): string {
    const resolved = path.resolve(this.#config.workspaceRoot, ...storageKey.split('/'));
    if (!resolved.startsWith(`${path.resolve(this.#config.workspaceRoot)}${path.sep}`)) {
      throw new Error('Workspace storage escaped its configured root.');
    }
    return resolved;
  }
}
