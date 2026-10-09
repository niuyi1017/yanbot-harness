import { gzipSync } from 'node:zlib';
import { pack, type Headers } from 'tar-stream';
export async function gitArchive(
  entries: Array<{ name: string; type?: Headers['type']; text?: string; linkname?: string }>,
): Promise<Buffer> {
  const archive = pack();
  const chunks: Buffer[] = [];
  const consume = (async () => {
    for await (const chunk of archive) chunks.push(Buffer.from(chunk as Uint8Array));
  })();
  for (const entry of entries)
    await new Promise<void>((resolve, reject) =>
      archive.entry(
        { name: entry.name, type: entry.type ?? 'file', ...(entry.linkname ? { linkname: entry.linkname } : {}) },
        entry.text ?? '',
        (error) => (error ? reject(error) : resolve()),
      ),
    );
  archive.finalize();
  await consume;
  return gzipSync(Buffer.concat(chunks));
}
