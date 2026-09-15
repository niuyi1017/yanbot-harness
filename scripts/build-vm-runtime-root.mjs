import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { stageRuntime } from './lib/runtime-staging.mjs';

// Explicit CI development artifact, not a production image or a new published Linux target.
assert.equal(process.platform, 'linux');
assert.equal(process.arch, 'arm64');
const execute = promisify(execFile);
const repository = path.resolve(import.meta.dirname, '..');
const output = path.resolve(process.argv[2]);
await mkdir(output, { mode: 0o700 });
const staging = path.join(output, 'staging');
await mkdir(staging);
const staged = await stageRuntime({ repository, root: staging, pnpmEntry: process.env.npm_execpath });
const root = path.join(output, 'root');
await mkdir(root);
await mkdir(path.join(root, 'harness/bin'), { recursive: true });
await cp(staged.directory, path.join(root, 'harness/runtime'), { recursive: true });
await cp(process.execPath, path.join(root, 'harness/bin/node'));
await cp(path.join(repository, 'native/guest/runtime-agent.mjs'), path.join(root, 'harness/runtime-agent.mjs'));
const bridge = path.join(root, 'harness/bin/vsock-bridge');
await execute('cc', ['-O2', '-Wall', '-Wextra', '-Werror', '-o', bridge, 'native/guest/vsock-bridge.c'], {
  cwd: repository,
});
const libraries = new Set();
for (const binary of [process.execPath, bridge]) {
  const { stdout } = await execute('ldd', [binary]);
  for (const line of stdout.split('\n')) {
    const name = line.match(/(?:=>\s+)?(\/[^\s]+)\s+\(/u)?.[1];
    if (name) libraries.add(name);
  }
}
const digests = [];
for (const library of libraries) {
  const source = await realpath(library);
  const destination = path.join(root, library);
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination);
  digests.push({
    path: library,
    sha256: createHash('sha256')
      .update(await readFile(source))
      .digest('hex'),
  });
}
await mkdir(path.join(root, 'usr/share/doc/harness-guest'), { recursive: true });
for (const name of ['libc6', 'libstdc++6', 'libgcc-s1']) {
  const file = '/usr/share/doc/' + name + '/copyright';
  await cp(file, path.join(root, 'usr/share/doc/harness-guest', name + '.copyright'));
}
await writeFile(
  path.join(root, 'harness/guest-build.json'),
  JSON.stringify(
    {
      schemaVersion: 1,
      target: 'linux-arm64',
      node: process.versions.node,
      sourceCommit: (await execute('git', ['rev-parse', 'HEAD'], { cwd: repository })).stdout.trim(),
      sourceLockSha256: createHash('sha256')
        .update(await readFile(path.join(repository, 'pnpm-lock.yaml')))
        .digest('hex'),
      runtimeInventory: staged.normalization.after.sha256,
      libraries: digests,
      productionTrusted: false,
    },
    null,
    2,
  ) + '\n',
);
await execute('tar', ['-czf', path.join(output, 'runtime-root.tar.gz'), '-C', root, '.'], { timeout: 120000 });
console.log(JSON.stringify({ artifact: path.join(output, 'runtime-root.tar.gz'), productionTrusted: false }));
