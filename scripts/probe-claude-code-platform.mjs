import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const version = '2.1.284';
const target = `${process.platform}-${process.arch}`;
const integrities = {
  'darwin-arm64': 'WczsKY4Bg4dlh5M2UILMHM/9xpBdDcXLulzCSE+TFIb6itI7q3kfYTIwvKOzxB557krwHEuKLgWkUiXGdojjVQ==',
  'linux-x64': 'hjjPgN4u8DvnzZqWDYnU5xxQkykuUrkUoVeeutVLXjrhx4qeRPmwgZ69BFAHmV42FBRdiRwbLbiDE9nkQdAE8g==',
  'win32-x64': 'Usw9Z8unwN6sWlhAJm5pBdTj5LoYBotUddhCBpnnH1XFJT9dgxRvRXqhftuVQi6LhorFo/HD0VfeHmmJFNCMaw==',
};
if (!integrities[target]) throw new Error('Unsupported probe platform.');
const root = await mkdtemp(path.join(tmpdir(), 'harness-claude-platform-'));
let report;
try {
  const name = `claude-code-${target}`;
  const response = await globalThis.fetch(`https://registry.npmjs.org/@anthropic-ai/${name}/-/${name}-${version}.tgz`, {
    signal: globalThis.AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error('Official package unavailable.');
  const chunks = [];
  let total = 0;
  for await (const bytes of response.body) {
    total += bytes.length;
    if (total > 512 * 1024 * 1024) throw new Error('Official package size limit exceeded.');
    chunks.push(bytes);
  }
  const archive = Buffer.concat(chunks);
  if (createHash('sha512').update(archive).digest('base64') !== integrities[target])
    throw new Error('Official package integrity mismatch.');
  const archivePath = path.join(root, 'vendor.tgz');
  await writeFile(archivePath, archive, { mode: 0o600 });
  await execute('tar', ['-xzf', archivePath, '-C', root], { timeout: 60_000 });
  const executable = path.join(root, 'package', process.platform === 'win32' ? 'claude.exe' : 'claude');
  await chmod(executable, 0o700);
  const result = await execute(process.execPath, [path.join(import.meta.dirname, 'smoke-claude-code-cli.mjs')], {
    env: { ...process.env, CLAUDE_CODE_EXECUTABLE: executable },
    timeout: 90_000,
    maxBuffer: 64 * 1024,
  });
  report = { ...JSON.parse(result.stdout), archiveSha512: integrities[target], archiveBytes: total };
} finally {
  // Windows may briefly retain executable handles after the runtime has closed.
  // Keep cleanup bounded and fail the probe if the lock outlives these retries.
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
const output = path.resolve(process.argv[2] ?? 'evidence');
await mkdir(output, { recursive: true });
await writeFile(path.join(output, `claude-code-${target}.json`), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ target, status: report.status, evidence: report.evidence }));
