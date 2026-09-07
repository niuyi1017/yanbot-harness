import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_TTL_MS = 30 * 60_000;
const MAX_TTL_MS = 24 * 60 * 60_000;

type WorkspaceGrantRecord = {
  grantId: string;
  secretHash: Buffer;
  workspaceRef: string;
  canonicalRoot: string;
  expiresAt: number;
  revoked: boolean;
};

export type WorkspaceGrantRegistryOptions = {
  now?: () => number;
  generateId?: () => string;
  generateSecret?: () => string;
};

export class WorkspaceGrantError extends Error {
  readonly code: 'INVALID_WORKSPACE' | 'INVALID_GRANT' | 'GRANT_EXPIRED' | 'WORKSPACE_OUTSIDE_GRANT';

  constructor(code: WorkspaceGrantError['code'], message: string) {
    super(message);
    this.name = 'WorkspaceGrantError';
    this.code = code;
  }
}

export class WorkspaceGrantRegistry {
  readonly #now: () => number;
  readonly #generateId: () => string;
  readonly #generateSecret: () => string;
  readonly #grants = new Map<string, WorkspaceGrantRecord>();

  constructor(options: WorkspaceGrantRegistryOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#generateId = options.generateId ?? randomUUID;
    this.#generateSecret = options.generateSecret ?? (() => randomBytes(32).toString('base64url'));
  }

  async issue(
    workspacePath: string,
    ttlMs = DEFAULT_TTL_MS,
  ): Promise<{
    grantId: string;
    grant: string;
    workspaceRef: string;
    expiresAt: string;
  }> {
    const canonicalRoot = await canonicalDirectory(workspacePath);
    const grantId = this.#generateId();
    const workspaceRef = this.#generateId();
    const secret = this.#generateSecret();
    const normalizedTtl = Number.isFinite(ttlMs) ? Math.floor(ttlMs) : DEFAULT_TTL_MS;
    const expiresAt = this.#now() + Math.min(MAX_TTL_MS, Math.max(1_000, normalizedTtl));
    this.#grants.set(grantId, {
      grantId,
      secretHash: hashSecret(secret),
      workspaceRef,
      canonicalRoot,
      expiresAt,
      revoked: false,
    });
    return { grantId, grant: `${grantId}.${secret}`, workspaceRef, expiresAt: new Date(expiresAt).toISOString() };
  }

  async resolve(grant: string, relativeCwd = '.'): Promise<{ path: string; grantId: string; workspaceRef: string }> {
    if (
      !relativeCwd ||
      relativeCwd.includes('\0') ||
      path.isAbsolute(relativeCwd) ||
      relativeCwd.startsWith('\\') ||
      /^[A-Za-z]:[\\/]/.test(relativeCwd) ||
      relativeCwd.split(/[\\/]+/u).includes('..')
    ) {
      throw new WorkspaceGrantError('WORKSPACE_OUTSIDE_GRANT', 'The requested working directory is outside the grant.');
    }
    const [grantId, secret] = splitOpaqueToken(grant);
    const record = grantId ? this.#grants.get(grantId) : undefined;
    if (!record || !secret || record.revoked || !secretMatches(secret, record.secretHash)) {
      throw new WorkspaceGrantError('INVALID_GRANT', 'The workspace grant is invalid or revoked.');
    }
    if (this.#now() >= record.expiresAt) {
      this.#grants.delete(record.grantId);
      throw new WorkspaceGrantError('GRANT_EXPIRED', 'The workspace grant has expired.');
    }
    const resolved = await canonicalDirectory(path.join(record.canonicalRoot, relativeCwd));
    if (!isWithin(record.canonicalRoot, resolved)) {
      throw new WorkspaceGrantError('WORKSPACE_OUTSIDE_GRANT', 'The requested working directory is outside the grant.');
    }
    return { path: resolved, grantId: record.grantId, workspaceRef: record.workspaceRef };
  }

  revoke(grantId: string): boolean {
    const record = this.#grants.get(grantId);
    if (!record || record.revoked) return false;
    record.revoked = true;
    return true;
  }
}

async function canonicalDirectory(value: string): Promise<string> {
  try {
    const canonical = await realpath(path.resolve(value));
    if (!(await stat(canonical)).isDirectory()) throw new Error('not a directory');
    return canonical;
  } catch {
    throw new WorkspaceGrantError(
      'INVALID_WORKSPACE',
      'The workspace does not exist or is not an accessible directory.',
    );
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function splitOpaqueToken(token: string): [string | undefined, string | undefined] {
  const separator = token.indexOf('.');
  if (separator <= 0 || separator === token.length - 1 || token.indexOf('.', separator + 1) >= 0) {
    return [undefined, undefined];
  }
  return [token.slice(0, separator), token.slice(separator + 1)];
}

function hashSecret(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function secretMatches(value: string, expected: Buffer): boolean {
  const actual = hashSecret(value);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
