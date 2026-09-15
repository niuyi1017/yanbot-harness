// Read-only package graph/asset audit for T1. Not a package resolver used by product code.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

export async function auditDeployedPackages(directory, options = {}) {
  const root = await realpath(directory);
  const nodes = new Map();
  async function discover(current) {
    const relative = path.relative(root, current).split(path.sep).join('/');
    if (current === root || /(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+$/u.test(relative)) {
      try {
        const manifest = JSON.parse(await readFile(path.join(current, 'package.json'), 'utf8'));
        if (manifest.name && manifest.version) {
          const assets = await assetDigest(current, root, options);
          nodes.set(await realpath(current), { manifest, assets });
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== '.bin') await discover(path.join(current, entry.name));
    }
  }
  await discover(root);
  const records = [];
  const recordByNode = new Map();
  const targetByEdge = new Map();
  for (const [location, node] of nodes) {
    const edges = [];
    const { manifest } = node;
    const dependencies = { ...manifest.peerDependencies, ...manifest.dependencies, ...manifest.optionalDependencies };
    for (const name of Object.keys(dependencies).sort()) {
      assert.match(name, /^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/iu);
      const resolved = await locate(location, name, root);
      if (!resolved) {
        assert(
          Object.hasOwn(manifest.optionalDependencies ?? {}, name) || manifest.peerDependenciesMeta?.[name]?.optional,
          `Required dependency missing: ${manifest.name} -> ${name}`,
        );
        edges.push({ dependency: name, missingOptional: true });
        continue;
      }
      const target = nodes.get(resolved);
      assert(target, `Resolved dependency outside audited graph: ${manifest.name} -> ${name}`);
      const edge = {
        dependency: name,
        package: `${target.manifest.name}@${target.manifest.version}`,
        assetSha256: target.assets.sha256,
      };
      edges.push(edge);
      targetByEdge.set(edge, target);
    }
    const record = { package: `${manifest.name}@${manifest.version}`, ...node.assets, edges };
    records.push(record);
    recordByNode.set(node, record);
  }
  // Refine equivalent contexts to distinguish identical package bytes with different peer graphs.
  // Refinement is duplicate-insensitive and terminates when no equivalence class splits.
  let classes = partition(records.map((record) => JSON.stringify([record.package, record.sha256])));
  const indexByRecord = new Map(records.map((record, index) => [record, index]));
  for (let step = 0; step <= records.length; step++) {
    const next = partition(
      records.map((record, index) =>
        JSON.stringify([
          classes[index],
          record.edges.map((edge) => [
            edge.dependency,
            edge.missingOptional ? 'missing' : classes[indexByRecord.get(recordByNode.get(targetByEdge.get(edge)))],
          ]),
        ]),
      ),
    );
    const stable = new Set(next).size === new Set(classes).size;
    classes = next;
    if (stable) break;
    assert(step < records.length, 'Graph refinement did not converge.');
  }
  for (const record of records)
    for (const edge of record.edges) {
      if (!edge.missingOptional) edge.context = classes[indexByRecord.get(recordByNode.get(targetByEdge.get(edge)))];
    }
  records.sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0));
  const distinct = [...new Map(records.map((record) => [JSON.stringify(record), record])).values()];
  return {
    packageCount: records.length,
    distinctPackageCount: distinct.length,
    graphSha256: hash(JSON.stringify(distinct)),
    layoutSha256: hash(JSON.stringify(records)),
    packages: records,
  };
}

function partition(signatures) {
  const labels = new Map([...new Set(signatures)].sort().map((signature, index) => [signature, index]));
  return signatures.map((signature) => labels.get(signature));
}

async function locate(location, name, root) {
  for (let current = location; ; current = path.dirname(current)) {
    if (path.basename(current) !== 'node_modules') {
      try {
        const resolved = await realpath(path.join(current, 'node_modules', name));
        const relative = path.relative(root, resolved);
        assert(
          relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
          'External package link.',
        );
        return resolved;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    if (current === root) return undefined;
  }
}

async function assetDigest(directory, root, options) {
  const entries = [];
  let bytes = 0;
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || (current === directory && entry.name === 'pnpm-lock.yaml')) continue;
      const file = path.join(current, entry.name);
      if ((options.ignoredFiles ?? []).includes(path.relative(root, file).split(path.sep).join('/'))) continue;
      if (options.omitPackageManifestBytes && current === directory && entry.name === 'package.json') continue;
      if (entry.isDirectory()) await walk(file);
      else {
        assert(entry.isFile(), `Non-file package asset: ${entry.name}`);
        const content = await readFile(file);
        bytes += content.length;
        entries.push(`${path.relative(directory, file).split(path.sep).join('/')}\0${hash(content)}`);
      }
    }
  }
  await walk(directory);
  return { files: entries.length, bytes, sha256: hash(entries.sort().join('\n')) };
}

export async function resolveDeployedDependency(root, directory, name) {
  assert.match(name, /^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/iu);
  const canonicalRoot = await realpath(root);
  const canonicalDirectory = await realpath(directory);
  const relative = path.relative(canonicalRoot, canonicalDirectory);
  assert(relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  const location = await locate(canonicalDirectory, name, canonicalRoot);
  return location ? JSON.parse(await readFile(path.join(location, 'package.json'), 'utf8')) : undefined;
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}
