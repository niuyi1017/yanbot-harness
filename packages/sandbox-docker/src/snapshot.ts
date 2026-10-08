import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import path from 'node:path';

export type SnapshotFile = { path: string; base64: string };
/** Source root has already been canonicalized and belongs to the control plane's immutable snapshot store. */
export async function readSnapshot(root: string): Promise<SnapshotFile[]> {
  const files: SnapshotFile[] = [];
  let total = 0;
  let entries = 0;
  const walk = async (relative: string, depth: number): Promise<void> => {
    if (depth > 16) throw new Error('Snapshot depth limit');
    for (const name of await readdir(path.join(root, relative))) {
      if (++entries > 2048 || /[\\\0]/.test(name)) throw new Error('Snapshot entry limit');
      const selected = path.join(relative, name);
      if (selected.length > 1024) throw new Error('Snapshot path limit');
      const absolute = path.join(root, selected);
      const info = await lstat(absolute);
      if (info.isDirectory()) {
        await walk(selected, depth + 1);
        continue;
      }
      if (!info.isFile()) throw new Error('Snapshot contains a special file');
      total += info.size;
      if (total > 16 * 1024 * 1024) throw new Error('Snapshot size limit');
      const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = await handle.stat();
        if (opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size)
          throw new Error('Snapshot changed');
        const bytes = Buffer.alloc(info.size + 1);
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
          if (!bytesRead) break;
          offset += bytesRead;
        }
        if (offset !== info.size) throw new Error('Snapshot changed');
        files.push({ path: selected.split(path.sep).join('/'), base64: bytes.subarray(0, offset).toString('base64') });
      } finally {
        await handle.close();
      }
    }
  };
  await walk('', 0);
  return files;
}
