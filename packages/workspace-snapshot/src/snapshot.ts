import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const WORKSPACE_SNAPSHOT_LIMITS = Object.freeze({
  entries: 10_000,
  totalBytes: 64 * 1024 * 1024,
  fileBytes: 16 * 1024 * 1024,
  pathBytes: 1_024,
});

export type WorkspaceManifestEntry =
  | { path: string; type: 'directory' }
  | { path: string; type: 'file'; size: number; sha256: string; executable: boolean };

export type WorkspaceManifest = { schemaVersion: 1; entries: WorkspaceManifestEntry[] };
export type WorkspacePayloadFile = { path: string; contentBase64: string };
export type ValidatedWorkspacePayload = {
  manifest: WorkspaceManifest;
  digest: `sha256:${string}`;
  files: Array<{ path: string; bytes: Uint8Array; executable: boolean }>;
};

export class WorkspaceSnapshotError extends Error {
  readonly code = 'CONFIGURATION_INVALID' as const;

  constructor(options?: ErrorOptions) {
    super('The workspace snapshot is invalid.', options);
    this.name = 'WorkspaceSnapshotError';
  }
}

export function validateWorkspaceManifest(
  value: unknown = { schemaVersion: 1, entries: [] },
  expectedDigest?: string,
): { manifest: WorkspaceManifest; digest: `sha256:${string}` } {
  try {
    if (!isObject(value) || !hasExactKeys(value, ['schemaVersion', 'entries'])) fail();
    if (value.schemaVersion !== 1 || !Array.isArray(value.entries)) fail();
    if (value.entries.length > WORKSPACE_SNAPSHOT_LIMITS.entries) fail();
    const entries: WorkspaceManifestEntry[] = [];
    const seen = new Map<string, WorkspaceManifestEntry>();
    let totalBytes = 0;
    for (const raw of value.entries) {
      if (!isObject(raw) || typeof raw.path !== 'string' || typeof raw.type !== 'string') fail();
      validateManifestPath(raw.path);
      if (/[<>"|?*]/u.test(raw.path)) fail();
      const identity = pathIdentity(raw.path);
      if (seen.has(identity)) fail();
      if (entries.length > 0 && entries.at(-1)!.path >= raw.path) fail();
      const parent = path.posix.dirname(raw.path);
      if (parent !== '.') {
        const parentEntry = seen.get(pathIdentity(parent));
        if (!parentEntry || parentEntry.path !== parent || parentEntry.type !== 'directory') fail();
      }
      let entry: WorkspaceManifestEntry;
      if (raw.type === 'directory') {
        if (!hasExactKeys(raw, ['path', 'type'])) fail();
        entry = { path: raw.path, type: 'directory' };
      } else if (raw.type === 'file') {
        if (!hasExactKeys(raw, ['path', 'type', 'size', 'sha256', 'executable'])) fail();
        if (
          !Number.isSafeInteger(raw.size) ||
          (raw.size as number) < 0 ||
          (raw.size as number) > WORKSPACE_SNAPSHOT_LIMITS.fileBytes
        ) {
          fail();
        }
        if (typeof raw.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(raw.sha256)) fail();
        if (typeof raw.executable !== 'boolean') fail();
        totalBytes += raw.size as number;
        if (totalBytes > WORKSPACE_SNAPSHOT_LIMITS.totalBytes) fail();
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
    const manifest: WorkspaceManifest = { schemaVersion: 1, entries };
    const digest = `sha256:${createHash('sha256')
      .update(`${JSON.stringify(manifest)}\n`)
      .digest('hex')}` as const;
    if (expectedDigest !== undefined && !safeEqual(digest, expectedDigest)) fail();
    return { manifest, digest };
  } catch (error) {
    if (error instanceof WorkspaceSnapshotError) throw error;
    throw new WorkspaceSnapshotError({ cause: error });
  }
}

export function validateWorkspacePayload(
  manifestValue: unknown,
  filesValue: unknown,
  expectedDigest?: string,
): ValidatedWorkspacePayload {
  try {
    const { manifest, digest } = validateWorkspaceManifest(manifestValue, expectedDigest);
    if (!Array.isArray(filesValue)) fail();
    const expectedFiles = manifest.entries.filter(
      (entry): entry is Extract<WorkspaceManifestEntry, { type: 'file' }> => entry.type === 'file',
    );
    if (filesValue.length !== expectedFiles.length) fail();
    const files = filesValue.map((raw, index) => {
      if (!isObject(raw) || !hasExactKeys(raw, ['path', 'contentBase64'])) fail();
      const expected = expectedFiles[index];
      if (!expected || raw.path !== expected.path || typeof raw.contentBase64 !== 'string') fail();
      if (!isCanonicalBase64(raw.contentBase64, expected.size)) fail();
      const bytes = Buffer.from(raw.contentBase64, 'base64');
      if (
        bytes.length !== expected.size ||
        !safeEqual(createHash('sha256').update(bytes).digest('hex'), expected.sha256)
      ) {
        fail();
      }
      return { path: expected.path, bytes: new Uint8Array(bytes), executable: expected.executable };
    });
    return { manifest, digest, files };
  } catch (error) {
    if (error instanceof WorkspaceSnapshotError) throw error;
    throw new WorkspaceSnapshotError({ cause: error });
  }
}

export async function writeWorkspaceSnapshot(destination: string, payload: ValidatedWorkspacePayload): Promise<void> {
  const resolved = path.resolve(destination);
  const parent = path.dirname(resolved);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(path.join(parent, '.snapshot-'));
  try {
    const fileByPath = new Map(payload.files.map((file) => [file.path, file]));
    for (const entry of payload.manifest.entries) {
      const target = resolveContained(staging, entry.path);
      if (entry.type === 'directory') {
        await mkdir(target, { mode: 0o700 });
      } else {
        const file = fileByPath.get(entry.path);
        if (!file) fail();
        await writeFile(target, file.bytes, { flag: 'wx', mode: file.executable ? 0o700 : 0o600 });
      }
    }
    if (await pathExists(resolved)) fail();
    await rename(staging, resolved);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    if (error instanceof WorkspaceSnapshotError) throw error;
    throw new WorkspaceSnapshotError({ cause: error });
  }
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await lstat(value);
    return true;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function validateManifestPath(relative: string): void {
  if (!relative || Buffer.byteLength(relative) > WORKSPACE_SNAPSHOT_LIMITS.pathBytes) fail();
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

function isCanonicalBase64(value: string, expectedBytes: number): boolean {
  if (
    value.length !== Math.ceil(expectedBytes / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  ) {
    return false;
  }
  return Buffer.from(value, 'base64').toString('base64') === value;
}

function resolveContained(root: string, relative: string): string {
  const resolved = path.resolve(root, ...relative.split('/'));
  if (!resolved.startsWith(`${path.resolve(root)}${path.sep}`)) fail();
  return resolved;
}

function pathIdentity(value: string): string {
  return value.normalize('NFC').toLocaleLowerCase('en-US');
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && leftBuffer.equals(rightBuffer);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(): never {
  throw new WorkspaceSnapshotError();
}
