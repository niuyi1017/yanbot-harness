// CI-only image fixture installer. This never publishes or globally installs the vendor CLI.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
const execute = promisify(execFile);
if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Fixture installer requires Linux x64.');
const destination = process.argv[2];
if (!destination || !path.isAbsolute(destination)) throw new Error('Absolute fixture destination required.');
const root = await mkdtemp(path.join(tmpdir(), 'claude-image-fixture-'));
try {
  const response = await globalThis.fetch(
    'https://registry.npmjs.org/@anthropic-ai/claude-code-linux-x64/-/claude-code-linux-x64-2.1.284.tgz',
    { signal: globalThis.AbortSignal.timeout(120_000) },
  );
  if (!response.ok) throw new Error('Official fixture package unavailable.');
  const chunks = [];
  let total = 0;
  for await (const bytes of response.body) {
    total += bytes.length;
    if (total > 256 * 1024 * 1024) throw new Error('Package limit');
    chunks.push(bytes);
  }
  const archive = Buffer.concat(chunks);
  if (
    createHash('sha512').update(archive).digest('base64') !==
    'hjjPgN4u8DvnzZqWDYnU5xxQkykuUrkUoVeeutVLXjrhx4qeRPmwgZ69BFAHmV42FBRdiRwbLbiDE9nkQdAE8g=='
  )
    throw new Error('Official fixture integrity mismatch.');
  const archivePath = path.join(root, 'cli.tgz');
  await writeFile(archivePath, archive);
  await execute('tar', ['-xzf', archivePath, '-C', root], { timeout: 60_000 });
  await mkdir(destination, { recursive: true });
  await copyFile(path.join(root, 'package', 'claude'), path.join(destination, 'claude'));
  await chmod(path.join(destination, 'claude'), 0o755);
} finally {
  await rm(root, { recursive: true, force: true });
}
