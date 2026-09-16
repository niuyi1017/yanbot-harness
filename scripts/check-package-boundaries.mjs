import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const packagesRoot = path.join(repositoryRoot, 'packages');
const violations = [];
const release = JSON.parse(await readFile(path.join(repositoryRoot, 'release-version.json'), 'utf8'));
for (const relative of [
  'packages/contracts',
  'packages/sdk',
  'packages/local',
  'packages/runtime',
  'apps/cli',
  'apps/local-runtime',
]) {
  const manifest = JSON.parse(await readFile(path.join(repositoryRoot, relative, 'package.json'), 'utf8'));
  if (manifest.version !== release.version) violations.push(relative + ': release version drift');
  if (relative === 'packages/sdk') {
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      if (Object.keys(manifest[field] ?? {}).some((name) => name !== '@yanbot-harness/contracts'))
        violations.push(relative + ': SDK production graph may only enter contracts');
    }
  }
  if (relative === 'packages/runtime') {
    if (Object.keys(manifest.dependencies ?? {}).some((name) => name !== 'tar-stream'))
      violations.push(relative + ': runtime meta must not depend on SDK or business implementation');
    const expected = Object.fromEntries(
      ['darwin-arm64', 'win32-x64', 'linux-x64'].map((target) => [
        '@yanbot-harness/runtime-' + target,
        release.version,
      ]),
    );
    if (JSON.stringify(manifest.optionalDependencies) !== JSON.stringify(expected))
      violations.push(relative + ': platform mapping/version drift');
  }
  if (
    relative === 'packages/local' &&
    JSON.stringify(Object.keys(manifest.dependencies).sort()) !==
      JSON.stringify(['@yanbot-harness/runtime', '@yanbot-harness/sdk'])
  )
    violations.push(relative + ': facade dependency drift');
}
for (const relative of ['packages/contracts/src/index.ts', 'packages/runtime/lib/manifest.mjs']) {
  const content = await readFile(path.join(repositoryRoot, relative), 'utf8');
  if (!content.includes("'" + release.version + "'"))
    violations.push(relative + ': generated version differs from release descriptor');
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory() && ['.git', 'node_modules', 'dist', 'coverage', 'delivery-output'].includes(entry.name))
      continue;
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
  if (/\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/.test(file)) {
    const content = await readFile(file, 'utf8');
    if (
      relative !== 'scripts/check-package-boundaries.mjs' &&
      content.includes('@tencent-ai/agent-sdk') &&
      !relative.startsWith('packages/adapter-codebuddy/')
    ) {
      violations.push(`${relative}: CodeBuddy SDK may only be used by adapter-codebuddy`);
    }
    if (relative.startsWith('apps/local-runtime/src/')) {
      if (/\b(?:teacher|school|adjustment|report)\b|教师|院校|择校|调剂|报告/iu.test(content)) {
        violations.push(`${relative}: local runtime source must remain free of Yanbot business concepts`);
      }
      if (/\b(?:mongoose|mongodb|redis)\b/iu.test(content)) {
        violations.push(`${relative}: local runtime source must not depend on cloud data services`);
      }
      if (/bypassPermissions/u.test(content)) {
        violations.push(`${relative}: local runtime source must not expose permission bypasses`);
      }
      if (
        relative !== 'apps/local-runtime/src/main.ts' &&
        /CodeBuddy|@yanbot-harness\/adapter-codebuddy/iu.test(content)
      ) {
        violations.push(`${relative}: vendor composition is only allowed in the standalone entrypoint`);
      }
    }
    if (relative.startsWith('packages/sdk/src/')) {
      if (/@yanbot-harness\/(?:adapter-|core|local-runtime|runtime|local['"])/u.test(content)) {
        violations.push(`${relative}: public SDK source may only depend on contracts`);
      }
    }
    if (relative.startsWith('apps/cli/src/')) {
      if (/@yanbot-harness\/(?!sdk(?:['"/]))/u.test(content)) {
        violations.push(`${relative}: CLI source may only consume the public SDK`);
      }
      if (/bypassPermissions/u.test(content)) {
        violations.push(`${relative}: CLI source must not expose permission bypasses`);
      }
    }
  }
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
