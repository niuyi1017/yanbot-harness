import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const searchRoot = path.resolve(process.argv[2] ?? '.');
const requiredTargets = process.argv.slice(3);
const manifestFiles = (await filesNamed(searchRoot, 'manifest.json')).sort();
if (manifestFiles.length < 2) throw new Error('Expected at least two assembled release manifests.');

const manifests = [];
for (const file of manifestFiles) {
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  if (typeof manifest.target !== 'string' || !Array.isArray(manifest.artifacts)) continue;
  const packageArtifacts = manifest.artifacts
    .filter((artifact) => typeof artifact.path === 'string' && artifact.path.startsWith('packages/'))
    .map((artifact) => ({ path: artifact.path, sha256: artifact.sha256, size: artifact.size }))
    .sort((left, right) => left.path.localeCompare(right.path));
  if (packageArtifacts.length === 0) throw new Error(`${manifest.target}: package artifacts are missing.`);
  manifests.push({ target: manifest.target, packageArtifacts });
}

const targets = new Set(manifests.map((manifest) => manifest.target));
if (targets.size !== manifests.length) throw new Error('Duplicate release target manifests were found.');
for (const target of requiredTargets) {
  if (!targets.has(target)) throw new Error(`Required release target is missing: ${target}`);
}

const baseline = JSON.stringify(manifests[0].packageArtifacts);
for (const manifest of manifests.slice(1)) {
  if (JSON.stringify(manifest.packageArtifacts) !== baseline) {
    throw new Error(`Public package hashes differ for ${manifests[0].target} and ${manifest.target}.`);
  }
}

process.stdout.write(`Common package hashes match across: ${[...targets].sort().join(', ')}.\n`);

async function filesNamed(directory, name) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await filesNamed(absolute, name)));
    else if (entry.name === name) result.push(absolute);
  }
  return result;
}
