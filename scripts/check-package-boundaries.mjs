import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const packagesRoot = path.join(repositoryRoot, 'packages');
const violations = [];

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory() && ['.git', 'node_modules', 'dist', 'coverage'].includes(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(absolute)));
    else files.push(absolute);
  }
  return files;
}

for (const file of await walk(packagesRoot)) {
  if (!/\.(?:ts|tsx|mts|cts|json)$/.test(file)) continue;
  const relative = path.relative(repositoryRoot, file);
  const content = await readFile(file, 'utf8');

  if (content.includes('@tencent-ai/agent-sdk') && !relative.startsWith('packages/adapter-codebuddy/')) {
    violations.push(`${relative}: CodeBuddy SDK may only be used by adapter-codebuddy`);
  }
  if (/from\s+['"]@yanbot-harness\/[^'"]+\/src(?:\/|['"])/.test(content)) {
    violations.push(`${relative}: workspace packages must be imported through public exports`);
  }
}

for (const file of await walk(repositoryRoot)) {
  const relative = path.relative(repositoryRoot, file);
  const basename = path.basename(file);
  if (relative !== 'pnpm-lock.yaml' && ['package-lock.json', 'pnpm-lock.yaml'].includes(basename)) {
    violations.push(`${relative}: nested lockfiles are forbidden`);
  }
  if (basename === '.env' || /^\.env\.(?!example$)/.test(basename)) {
    violations.push(`${relative}: environment files are forbidden`);
  }
  if (/\.(?:pem|p12|pfx|key)$/i.test(basename)) {
    violations.push(`${relative}: private key and certificate containers are forbidden`);
  }
}

if (violations.length > 0) {
  console.error(violations.join('\n'));
  process.exitCode = 1;
} else {
  console.log('Package boundary checks passed.');
}
