import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { CliUsageError } from './arguments.js';

const limits = { entries: 10_000, totalBytes: 64 * 1024 * 1024, fileBytes: 16 * 1024 * 1024, pathBytes: 1_024 };
type Entry =
  | { path: string; type: 'directory' }
  | { path: string; type: 'file'; size: number; sha256: string; executable: boolean };

export async function serializeWorkspaceSnapshot(root: string) {
  try {
    const resolvedRoot = path.resolve(root);
    const rootStatus = await lstat(resolvedRoot);
    if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) fail();
    const entries: Entry[] = [];
    const files: Array<{ path: string; contentBase64: string }> = [];
    let totalBytes = 0;
    await visit('');
    return { manifest: { schemaVersion: 1 as const, entries }, files };

    async function visit(relativeDirectory: string): Promise<void> {
      const directory = relativeDirectory ? path.join(resolvedRoot, ...relativeDirectory.split('/')) : resolvedRoot;
      const names = (await readdir(directory)).sort();
      for (const name of names) {
        if (name.toLocaleLowerCase('en-US') === '.git') continue;
        const relative = relativeDirectory ? `${relativeDirectory}/${name}` : name;
        validatePath(relative);
        const absolute = path.join(resolvedRoot, ...relative.split('/'));
        const status = await lstat(absolute);
        if (status.isSymbolicLink()) fail();
        if (status.isDirectory()) {
          entries.push({ path: relative, type: 'directory' });
          if (entries.length > limits.entries) fail();
          await visit(relative);
          continue;
        }
        if (!status.isFile() || status.size > limits.fileBytes) fail();
        totalBytes += status.size;
        if (totalBytes > limits.totalBytes) fail();
        const bytes = await readFile(absolute);
        if (bytes.byteLength !== status.size) fail();
        entries.push({
          path: relative,
          type: 'file',
          size: bytes.byteLength,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          executable: (status.mode & 0o111) !== 0,
        });
        files.push({ path: relative, contentBase64: bytes.toString('base64') });
        if (entries.length > limits.entries) fail();
      }
    }
  } catch (error) {
    if (error instanceof CliUsageError) throw error;
    throw new CliUsageError('The snapshot workspace cannot be serialized.', { cause: error });
  }
}

function validatePath(relative: string): void {
  if (!relative || Buffer.byteLength(relative) > limits.pathBytes || /[\\:<>"|?*]/u.test(relative)) fail();
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

function fail(): never {
  throw new CliUsageError('The snapshot workspace contains an unsupported file or exceeds the upload limits.');
}
