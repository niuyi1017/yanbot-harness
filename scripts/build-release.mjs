import { execFile } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, '..');
const version = JSON.parse(
  await readFile(path.join(repositoryRoot, 'packages/contracts/package.json'), 'utf8'),
).version;
const releaseRoot = path.join(repositoryRoot, 'release', version);
const workRoot = path.join(repositoryRoot, 'release-work', `local-${process.pid}`);
const commonRoot = path.join(workRoot, 'common');
const runtimeRoot = path.join(workRoot, 'runtime');
const skipCheck = process.argv.includes('--skip-check');

await rm(workRoot, { recursive: true, force: true });
await mkdir(workRoot, { recursive: true, mode: 0o700 });
try {
  if (skipCheck) await runPnpm(['build']);
  else await runPnpm(['check']);
  await runNode('scripts/build-client-packages.mjs', [commonRoot, '--skip-build']);
  await runNode('scripts/build-runtime-bundle.mjs', [runtimeRoot, '--skip-build']);
  await runNode('scripts/assemble-release.mjs', [commonRoot, runtimeRoot, releaseRoot]);
  process.stdout.write(`${releaseRoot}\n`);
} finally {
  await rm(workRoot, { recursive: true, force: true });
}

async function runNode(script, arguments_) {
  await executeFile(process.execPath, [path.join(repositoryRoot, script), ...arguments_], {
    cwd: repositoryRoot,
    env: { ...process.env, CI: 'true' },
    maxBuffer: 50 * 1024 * 1024,
  });
}

async function runPnpm(arguments_) {
  const npmExecPath = process.env.npm_execpath;
  const command = npmExecPath ? process.execPath : process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const args = npmExecPath ? [npmExecPath, ...arguments_] : arguments_;
  await executeFile(command, args, {
    cwd: repositoryRoot,
    env: { ...process.env, CI: 'true' },
    maxBuffer: 50 * 1024 * 1024,
  });
}
