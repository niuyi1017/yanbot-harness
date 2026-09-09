import { execFile } from 'node:child_process';
import { chmod, cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, '..');
const outputDirectory = path.resolve(process.argv[2] ?? path.join(repositoryRoot, 'release-runtime'));
const runtimePackagePath = path.join(repositoryRoot, 'apps/local-runtime/package.json');
const runtimePackage = JSON.parse(await readFile(runtimePackagePath, 'utf8'));
const vendorSdkPackageName = ['@tencent-ai', 'agent-sdk'].join('/');
const codeBuddyPackage = JSON.parse(
  await readFile(path.join(repositoryRoot, 'packages/adapter-codebuddy/package.json'), 'utf8'),
);
const version = runtimePackage.version;
const platform = `${process.platform}-${process.arch}`;
const bundleName = `yanbot-harness-runtime-${version}-${platform}`;
const stagingParent = path.join(outputDirectory, `.staging-${process.pid}`);
const installDirectory = path.join(stagingParent, 'install');
const packDirectory = path.join(stagingParent, 'packs');
const stagingDirectory = path.join(stagingParent, bundleName);
const archivePath = path.join(outputDirectory, `${bundleName}.tar.gz`);

assertSafeOutput(outputDirectory);
await rm(stagingParent, { recursive: true, force: true });
await mkdir(packDirectory, { recursive: true, mode: 0o700 });
await mkdir(installDirectory, { recursive: true, mode: 0o700 });
await mkdir(outputDirectory, { recursive: true, mode: 0o700 });

try {
  await runPnpm(['build']);
  const packageNames = await runtimeWorkspaceDependencyNames();
  for (const packageName of packageNames) {
    await runPnpm(['--filter', packageName, 'pack', '--pack-destination', packDirectory]);
  }
  const archives = (await readdir(packDirectory))
    .filter((name) => name.endsWith('.tgz'))
    .map((name) => path.join(packDirectory, name));
  await writeFile(path.join(installDirectory, 'package.json'), '{"private":true}\n');
  await executeFile(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', ...archives],
    { cwd: installDirectory, env: { ...process.env, CI: 'true' }, maxBuffer: 20 * 1024 * 1024 },
  );

  const installedRuntime = path.join(installDirectory, 'node_modules/@yanbot-harness/local-runtime');
  await mkdir(stagingDirectory, { recursive: true });
  for (const entry of await readdir(installedRuntime)) {
    if (entry === 'node_modules') continue;
    await cp(path.join(installedRuntime, entry), path.join(stagingDirectory, entry), {
      recursive: true,
      dereference: true,
    });
  }
  await rename(path.join(installDirectory, 'node_modules'), path.join(stagingDirectory, 'node_modules'));
  await rm(path.join(stagingDirectory, 'node_modules/@yanbot-harness/local-runtime'), {
    recursive: true,
    force: true,
  });
  await rm(path.join(stagingDirectory, 'node_modules/.bin/yanbot-harness-runtime'), { force: true });
  await removeGeneratedFiles(stagingDirectory);

  await mkdir(path.join(stagingDirectory, 'bin'), { recursive: true });
  const launcherPath = path.join(stagingDirectory, 'bin', 'yanbot-harness-runtime');
  await writeFile(
    launcherPath,
    '#!/bin/sh\nset -eu\nexec "${NODE_BINARY:-node}" "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/../dist/main.js" "$@"\n',
    { mode: 0o755 },
  );
  await chmod(launcherPath, 0o755);
  await writeFile(
    path.join(stagingDirectory, 'runtime-manifest.json'),
    `${JSON.stringify(
      {
        version,
        protocolVersion: '1.0.0',
        node: runtimePackage.engines.node,
        platform: process.platform,
        arch: process.arch,
        codeBuddySdkVersion: codeBuddyPackage.dependencies[vendorSdkPackageName],
      },
      null,
      2,
    )}\n`,
  );
  await executeFile('tar', ['-czf', archivePath, '-C', stagingParent, bundleName], {
    cwd: repositoryRoot,
    maxBuffer: 20 * 1024 * 1024,
  });
  process.stdout.write(`${archivePath}\n`);
} finally {
  await rm(stagingParent, { recursive: true, force: true });
}

async function runtimeWorkspaceDependencyNames() {
  const manifests = new Map();
  for (const directory of ['packages', 'apps']) {
    for (const entry of await readdir(path.join(repositoryRoot, directory), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = path.join(repositoryRoot, directory, entry.name, 'package.json');
      try {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        manifests.set(manifest.name, manifest);
      } catch {
        // Ignore directories that are not workspace packages.
      }
    }
  }
  const selected = new Set();
  const visit = (name) => {
    if (selected.has(name)) return;
    const manifest = manifests.get(name);
    if (!manifest) return;
    selected.add(name);
    for (const dependency of Object.keys(manifest.dependencies ?? {})) visit(dependency);
  };
  visit(runtimePackage.name);
  return [...selected].sort();
}

async function runPnpm(arguments_) {
  const npmExecPath = process.env.npm_execpath;
  const command = npmExecPath ? process.execPath : process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const args = npmExecPath ? [npmExecPath, ...arguments_] : arguments_;
  await executeFile(command, args, {
    cwd: repositoryRoot,
    env: { ...process.env, CI: 'true' },
    maxBuffer: 20 * 1024 * 1024,
  });
}

async function removeGeneratedFiles(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '.git' || entry.name === 'test' || entry.name === 'tests' || entry.name === '__tests__') {
        await rm(absolute, { recursive: true, force: true });
      } else {
        await removeGeneratedFiles(absolute);
      }
    } else if (
      /\.(?:map|pem|key|p12|pfx)$/iu.test(entry.name) ||
      entry.name === 'pnpm-lock.yaml' ||
      (entry.name.startsWith('.env') && entry.name !== '.env.example')
    ) {
      await rm(absolute, { force: true });
    }
  }
}

function assertSafeOutput(directory) {
  const relative = path.relative(repositoryRoot, directory);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Runtime bundle output must be a dedicated directory inside the repository.');
  }
}
