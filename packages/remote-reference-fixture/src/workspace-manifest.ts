import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import path from 'node:path';

import type { HarnessErrorCode } from '@yanbot-harness/contracts';

export const REMOTE_WORKSPACE_LIMITS = Object.freeze({
  entries: 10_000,
  totalBytes: 64 * 1024 * 1024,
  fileBytes: 16 * 1024 * 1024,
  pathBytes: 1_024,
});

export type RemoteWorkspaceManifestEntry =
  | { path: string; type: 'directory' }
  | { path: string; type: 'file'; size: number; sha256: string; executable: boolean };

export type RemoteWorkspaceManifest = {
  schemaVersion: 1;
  entries: RemoteWorkspaceManifestEntry[];
};

export class RemoteFixturePreparationError extends Error {
  readonly code: HarnessErrorCode = 'CONFIGURATION_INVALID';

  constructor(options?: ErrorOptions) {
    super('The workspace manifest is invalid.', options);
    this.name = 'RemoteFixturePreparationError';
  }
}

export function validateRemoteWorkspaceManifest(
  value: unknown = { schemaVersion: 1, entries: [] },
  expectedDigest?: string,
): { manifest: RemoteWorkspaceManifest; digest: `sha256:${string}` } {
  try {
    if (!isObject(value) || !hasExactKeys(value, ['schemaVersion', 'entries'])) fail();
    if (value.schemaVersion !== 1 || !Array.isArray(value.entries)) fail();
    if (value.entries.length > REMOTE_WORKSPACE_LIMITS.entries) fail();

    const entries: RemoteWorkspaceManifestEntry[] = [];
    const seen = new Map<string, RemoteWorkspaceManifestEntry>();
    let totalBytes = 0;
    for (const raw of value.entries) {
      if (!isObject(raw) || typeof raw.path !== 'string' || typeof raw.type !== 'string') fail();
      validateManifestPath(raw.path);
      if (/[<>"|?*]/u.test(raw.path)) fail();
      const identity = raw.path.normalize('NFC').toLocaleLowerCase('en-US');
      if (seen.has(identity)) fail();
      if (entries.length > 0 && entries.at(-1)!.path >= raw.path) fail();
      const parent = path.posix.dirname(raw.path);
      if (parent !== '.') {
        const parentEntry = seen.get(parent.normalize('NFC').toLocaleLowerCase('en-US'));
        if (!parentEntry || parentEntry.path !== parent || parentEntry.type !== 'directory') fail();
      }

      let entry: RemoteWorkspaceManifestEntry;
      if (raw.type === 'directory') {
        if (!hasExactKeys(raw, ['path', 'type'])) fail();
        entry = { path: raw.path, type: 'directory' };
      } else if (raw.type === 'file') {
        if (!hasExactKeys(raw, ['path', 'type', 'size', 'sha256', 'executable'])) fail();
        if (
          !Number.isSafeInteger(raw.size) ||
          (raw.size as number) < 0 ||
          (raw.size as number) > REMOTE_WORKSPACE_LIMITS.fileBytes
        ) {
          fail();
        }
        if (typeof raw.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(raw.sha256)) fail();
        if (typeof raw.executable !== 'boolean') fail();
        totalBytes += raw.size as number;
        if (totalBytes > REMOTE_WORKSPACE_LIMITS.totalBytes) fail();
        entry = {
          path: raw.path,
          type: 'file',
          size: raw.size as number,
          sha256: raw.sha256,
          executable: raw.executable,
        };
      } else {
        fail();
      }
      entries.push(entry);
      seen.set(identity, entry);
    }

    const manifest: RemoteWorkspaceManifest = { schemaVersion: 1, entries };
    const digest = `sha256:${createHash('sha256')
      .update(`${JSON.stringify(manifest)}\n`)
      .digest('hex')}` as const;
    if (expectedDigest !== undefined && !safeDigestEqual(digest, expectedDigest)) fail();
    return { manifest, digest };
  } catch (error) {
    if (error instanceof RemoteFixturePreparationError) throw error;
    throw new RemoteFixturePreparationError({ cause: error });
  }
}

function validateManifestPath(relative: string): void {
  if (!relative || Buffer.byteLength(relative) > REMOTE_WORKSPACE_LIMITS.pathBytes) fail();
  if (
    relative.startsWith('/') ||
    path.posix.isAbsolute(relative) ||
    /[\\:]/u.test(relative) ||
    [...relative].some((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint < 32 || codePoint === 127;
    })
  ) {
    fail();
  }
  for (const part of relative.split('/')) {
    if (!part || part === '.' || part === '..' || /[. ]$/u.test(part)) fail();
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part)) fail();
    if (
      /^(?:\.git|\.npmrc)$/iu.test(part) ||
      /^\.env(?:$|\.(?!example$))/iu.test(part) ||
      /\.(?:pem|key|p12|pfx)$/iu.test(part)
    ) {
      fail();
    }
  }
}

function safeDigestEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && leftBuffer.equals(rightBuffer);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === [...expected].sort()[index]);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(): never {
  throw new RemoteFixturePreparationError();
}
