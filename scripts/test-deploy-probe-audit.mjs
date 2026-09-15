import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { auditDeployedPackages } from './lib/deploy-probe-audit.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'harness-graph-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function pkg(directory, name, version, extra = {}) {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name, version, ...extra }));
  await writeFile(path.join(directory, 'index.js'), 'export const asset = true;\n');
}

test('package graph and asset hashes survive relocation', async (t) => {
  const root = await fixture(t);
  const original = path.join(root, 'source');
  await pkg(original, 'root', '1', { dependencies: { dep: '1' } });
  await pkg(path.join(original, 'node_modules/dep'), 'dep', '1');
  await cp(original, path.join(root, '中文 moved'), { recursive: true });
  assert.deepEqual(await auditDeployedPackages(original), await auditDeployedPackages(path.join(root, '中文 moved')));
});

test('detects changed resolution even when the same package versions remain installed', async (t) => {
  const root = await fixture(t);
  await pkg(root, 'root', '1', { dependencies: { parent: '1' } });
  const parent = path.join(root, 'node_modules/parent');
  await pkg(parent, 'parent', '1', { dependencies: { dep: '*' } });
  await pkg(path.join(root, 'node_modules/dep'), 'dep', '1');
  await pkg(path.join(parent, 'node_modules/dep'), 'dep', '2');
  const before = await auditDeployedPackages(root);
  await pkg(path.join(root, 'node_modules/dep'), 'dep', '2');
  await pkg(path.join(parent, 'node_modules/dep'), 'dep', '1');
  const after = await auditDeployedPackages(root);
  assert.equal(before.packageCount, after.packageCount);
  assert.notEqual(before.graphSha256, after.graphSha256);
});

test('detects missing embedded vendor assets rather than checking exports only', async (t) => {
  const root = await fixture(t);
  await pkg(root, 'root', '1');
  await mkdir(path.join(root, 'cli'));
  await writeFile(path.join(root, 'cli/helper.js'), '// bundled helper\n');
  const before = await auditDeployedPackages(root);
  await rm(path.join(root, 'cli/helper.js'));
  assert.notEqual((await auditDeployedPackages(root)).graphSha256, before.graphSha256);
});

test('records physical duplication separately without ignoring changed assets or edges', async (t) => {
  const root = await fixture(t);
  await pkg(root, 'root', '1', { dependencies: { parent: '1', dep: '1' } });
  await pkg(path.join(root, 'node_modules/parent'), 'parent', '1', { dependencies: { dep: '1' } });
  await pkg(path.join(root, 'node_modules/dep'), 'dep', '1');
  const before = await auditDeployedPackages(root);
  await pkg(path.join(root, 'node_modules/parent/node_modules/dep'), 'dep', '1');
  const after = await auditDeployedPackages(root);
  assert.equal(after.graphSha256, before.graphSha256);
  assert.equal(after.packageCount, before.packageCount + 1);
  assert.notEqual(after.layoutSha256, before.layoutSha256);
});

test('detects rewiring identical plugin bytes between distinct peer contexts', async (t) => {
  const root = await fixture(t);
  await pkg(root, 'root', '1', { dependencies: { a: '1', b: '1' } });
  for (const name of ['a', 'b']) {
    const owner = path.join(root, 'node_modules', name);
    await pkg(owner, name, '1', { dependencies: { plugin: '1' } });
    await pkg(path.join(owner, 'node_modules/plugin'), 'plugin', '1', { peerDependencies: { host: '*' } });
    await pkg(path.join(owner, 'node_modules/host'), 'host', name === 'a' ? '1' : '2');
  }
  const before = await auditDeployedPackages(root);
  await pkg(path.join(root, 'node_modules/a/node_modules/host'), 'host', '2');
  await pkg(path.join(root, 'node_modules/b/node_modules/host'), 'host', '1');
  assert.notEqual((await auditDeployedPackages(root)).graphSha256, before.graphSha256);
});

test('records missing optional dependencies but rejects missing mandatory peers', async (t) => {
  const root = await fixture(t);
  await pkg(root, 'root', '1', {
    optionalDependencies: { platform: '1' },
    peerDependencies: { host: '1' },
    peerDependenciesMeta: { host: { optional: true } },
  });
  const audit = await auditDeployedPackages(root);
  assert(audit.packages[0].edges.every((edge) => edge.missingOptional));
  await pkg(root, 'root', '1', { peerDependencies: { host: '1' } });
  await assert.rejects(auditDeployedPackages(root), /Required dependency missing/u);
});

test('rejects dependency links escaping staging', async (t) => {
  const root = await fixture(t);
  const source = path.join(root, 'source');
  await pkg(source, 'root', '1', { dependencies: { dep: '1' } });
  await pkg(path.join(root, 'outside'), 'dep', '1');
  await mkdir(path.join(source, 'node_modules'));
  await symlink(path.join(root, 'outside'), path.join(source, 'node_modules/dep'), 'junction');
  await assert.rejects(auditDeployedPackages(source), /External package link/u);
});
