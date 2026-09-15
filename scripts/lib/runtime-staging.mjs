import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, lstat, readFile, readdir, readlink, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { auditDeployedPackages } from './deploy-probe-audit.mjs';
import { NORMALIZATION_METADATA, normalizeRuntimeStaging } from './normalize-runtime-staging.mjs';

const execute = promisify(execFile);

export async function stageRuntime({ repository, root, pnpmEntry, signal }) {
  assert(pnpmEntry && /pnpm/iu.test(pnpmEntry), 'Run using pnpm.');
  const original = path.join(root, 'isolated');
  const hoisted = path.join(root, 'hoisted');
  const linkFree = path.join(root, 'link-free');
  const normalized = path.join(root, 'normalized');
  const lock = await readFile(path.join(repository, 'pnpm-lock.yaml'));
  for (const [destination, additional] of [
    [original, []],
    [hoisted, ['--config.node-linker=hoisted']],
  ]) {
    await execute(
      process.execPath,
      [
        pnpmEntry,
        '--filter',
        '@yanbot-harness/local-runtime',
        'deploy',
        '--prod',
        '--offline',
        '--frozen-lockfile',
        '--ignore-scripts',
        ...additional,
        destination,
      ],
      { cwd: repository, signal, timeout: 120000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
    );
  }
  assert(lock.equals(await readFile(path.join(repository, 'pnpm-lock.yaml'))), 'Build lock changed.');
  const before = await auditDeployedPackages(original);
  const after = await auditDeployedPackages(hoisted);
  assert.equal(before.graphSha256, after.graphSha256, 'Hoisting changed the dependency/resource graph.');
  const shims = await materializeBinLinks(hoisted, linkFree);
  const ownedPackages = [JSON.parse(await readFile(path.join(repository, 'apps/local-runtime/package.json'), 'utf8'))];
  for (const entry of await readdir(path.join(repository, 'packages'), { withFileTypes: true })) {
    if (entry.isDirectory())
      ownedPackages.push(
        JSON.parse(await readFile(path.join(repository, 'packages', entry.name, 'package.json'), 'utf8')),
      );
  }
  const normalization = await normalizeRuntimeStaging({
    source: linkFree,
    destination: normalized,
    ownedPackages,
    forbiddenRoots: [repository, await realpath(repository), root, await realpath(root)],
  });
  const comparison = { omitPackageManifestBytes: true, ignoredFiles: NORMALIZATION_METADATA };
  const sourceGraph = await auditDeployedPackages(linkFree, comparison);
  const targetGraph = await auditDeployedPackages(normalized, comparison);
  assert.equal(sourceGraph.graphSha256, targetGraph.graphSha256);
  assert.equal(sourceGraph.layoutSha256, targetGraph.layoutSha256);
  return { directory: normalized, shims, normalization, graph: targetGraph };
}

export async function materializeBinLinks(source, destination) {
  const links = [];
  const canonicalSource = await realpath(source);
  await cp(source, destination, {
    recursive: true,
    filter: async (file) => {
      if (!(await lstat(file)).isSymbolicLink()) return true;
      const relative = path.relative(source, file);
      assert.equal(path.basename(path.dirname(file)), '.bin', 'Only package-manager bin links may become shims.');
      assert.notEqual(process.platform, 'win32', 'Windows symlink conversion requires its own tested shim.');
      const resolved = await realpath(file);
      const within = path.relative(canonicalSource, resolved);
      assert(
        within !== '..' && !within.startsWith(`..${path.sep}`) && !path.isAbsolute(within),
        'External bin target.',
      );
      assert.match((await readFile(resolved, 'utf8')).split('\n')[0], /^#!\/usr\/bin\/env node\r?$/u);
      const target = await readlink(file);
      assert(!path.isAbsolute(target));
      assert.match(target, /^[a-zA-Z0-9_./@+-]+$/u);
      links.push({ path: relative, target });
      return false;
    },
  });
  for (const link of links) {
    await writeFile(
      path.join(destination, link.path),
      `#!/bin/sh\nset -eu\nexec "\${NODE_BINARY:-node}" "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/${link.target}" "$@"\n`,
      { mode: 0o755 },
    );
  }
  if (process.platform === 'win32') {
    const { normalizeWindowsBinShims } = await import('./windows-bin-shims.mjs');
    links.push(...(await normalizeWindowsBinShims(destination)));
  }
  return links;
}
