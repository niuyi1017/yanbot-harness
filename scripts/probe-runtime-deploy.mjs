// T1 audit of pnpm deploy, not a release builder or a vendor certification.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { startManagedRuntime } from '../packages/sdk/dist/index.js';

const executeFile = promisify(execFile);
const repository = path.resolve(import.meta.dirname, '..');
const pnpmEntry = process.env.npm_execpath;
assert(pnpmEntry && /pnpm/iu.test(pnpmEntry), 'Run via pnpm probe:runtime-deploy after building.');
const args = process.argv.slice(2).filter((item) => item !== '--');
assert(args.length === 0 || (args.length === 2 && args[0] === '--output-dir'), 'Use --output-dir DIRECTORY');
const outputParent = args.length ? path.resolve(args[1]) : tmpdir();
await mkdir(outputParent, { recursive: true });
const root = await mkdtemp(path.join(outputParent, 'harness-runtime-deploy-probe-'));
const deployed = path.join(root, 'deploy');
const relocated = path.join(root, 'relocated 中文 space &');
const lockBefore = await readFile(path.join(repository, 'pnpm-lock.yaml'));
const runtimePackage = JSON.parse(await readFile(path.join(repository, 'apps/local-runtime/package.json'), 'utf8'));
const report = {
  schemaVersion: 1,
  kind: 'runtime-deploy-mechanism-probe',
  scriptSha256: hash(await readFile(import.meta.filename)),
  target: `${process.platform}-${process.arch}`,
  node: process.version,
  lockSha256: hash(lockBefore),
  limitations: [
    'Offline deployment uses the existing frozen-lock pnpm store; this is not an empty-cache install.',
    'Raw deploy includes local file references and package-manager metadata; it is not a distributable payload.',
    'Reference startup/run/close only; vendor executable availability is an inventory, not permission or real-vendor certification.',
    'Relocation retains internal symlinks; link-free payload assembly and extraction limits remain T1/T2 work.',
  ],
};
try {
  const pnpm = await executeFile(process.execPath, [pnpmEntry, '--version'], { cwd: repository });
  report.pnpm = pnpm.stdout.trim();
  assert.equal(report.pnpm, '11.10.0');
  const deployment = await executeFile(
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
      deployed,
    ],
    {
      cwd: repository,
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    },
  );
  report.deploymentSummary = deployment.stdout.replaceAll(repository, '<repo>').replaceAll(root, '<probe-root>');
  assert.equal(hash(await readFile(path.join(repository, 'pnpm-lock.yaml'))), report.lockSha256, 'Root lock changed.');
  report.original = await inventory(deployed);
  assert.equal(report.original.externalLinks.length, 0, 'Deploy contains links outside staging.');
  for (const name of ['typescript', 'vitest', '@yanbot-harness/testing']) {
    assert(!report.original.packages.some((item) => item.name === name), `Unexpected development package: ${name}`);
  }
  await cp(deployed, relocated, { recursive: true, verbatimSymlinks: true });
  report.relocated = await inventory(relocated);
  assert.equal(report.relocated.externalLinks.length, 0, 'Relocation still points into original staging.');
  assert.equal(report.relocated.fileTreeSha256, report.original.fileTreeSha256);
  const runtime = await startManagedRuntime({
    executablePath: path.join(relocated, 'dist/main.js'),
    reference: true,
    environment: Object.fromEntries(
      ['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR'].flatMap((key) =>
        process.env[key] ? [[key, process.env[key]]] : [],
      ),
    ),
    startupTimeoutMs: 15_000,
  });
  let terminal;
  try {
    const health = await runtime.client.health();
    const [adapter] = await runtime.client.listAdapters();
    const workspace = path.join(root, 'workspace');
    await mkdir(workspace);
    const grant = await runtime.client.grantWorkspace({ path: workspace });
    const session = await runtime.client.createSession({ adapterId: adapter.manifest.adapterId });
    const run = await runtime.client.createRun(session.sessionId, {
      prompt: 'T1 relocated deploy Reference probe',
      workspaceGrant: grant.grant,
      permissionPolicy: 'read-only',
      configScopes: [],
      extensions: [],
      resume: false,
    });
    for await (const event of run.events({ signal: globalThis.AbortSignal.timeout(15_000) })) {
      if (['run.completed', 'run.failed', 'run.cancelled'].includes(event.type)) terminal = event.type;
    }
    assert.equal(terminal, 'run.completed');
    report.reference = { health, terminal, version: runtimePackage.version };
  } finally {
    await runtime.close();
  }
  await assert.rejects(stat(runtime.descriptorPath), { code: 'ENOENT' });
  report.reference.cleanedDescriptor = true;
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = String(error.message).replaceAll(repository, '<repo>').replaceAll(root, '<probe-root>').slice(0, 4000);
  process.exitCode = 1;
} finally {
  await writeFile(path.join(root, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status: report.status, report: path.join(root, 'report.json') }));
}

async function inventory(directory) {
  const canonicalRoot = await realpath(directory);
  const result = {
    files: 0,
    bytes: 0,
    links: 0,
    externalLinks: [],
    packages: [],
    localReferenceManifests: [],
    fileTreeSha256: '',
  };
  const fileDigests = [];
  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const file = path.join(current, entry.name);
      const relative = path.relative(directory, file).split(path.sep).join('/');
      if (entry.isSymbolicLink()) {
        result.links++;
        const destination = path.relative(canonicalRoot, await realpath(file));
        if (destination === '..' || destination.startsWith(`..${path.sep}`) || path.isAbsolute(destination))
          result.externalLinks.push(relative);
      } else if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) {
        const bytes = await readFile(file);
        result.files++;
        result.bytes += bytes.length;
        fileDigests.push(`${relative}\0${hash(bytes)}`);
        if (entry.name !== 'package.json') continue;
        const manifest = JSON.parse(bytes.toString('utf8'));
        if (!manifest.name || !manifest.version) continue;
        if (relative !== 'package.json' && !/(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+\/package\.json$/u.test(relative))
          continue;
        const licenseFiles = entries
          .filter(
            (candidate) => candidate.isFile() && /^(?:licen[sc]e|copying|notice)(?:[.-]|$)/iu.test(candidate.name),
          )
          .map((candidate) => candidate.name);
        const binaries = typeof manifest.bin === 'string' ? { [manifest.name]: manifest.bin } : (manifest.bin ?? {});
        const binInventory = [];
        for (const [name, target] of Object.entries(binaries)) {
          const info = await stat(path.resolve(current, target));
          assert(info.isFile(), `Missing executable asset: ${manifest.name}/${name}`);
          binInventory.push({ name, path: target, bytes: info.size });
        }
        result.packages.push({
          name: manifest.name,
          version: manifest.version,
          license: manifest.license ?? null,
          licenseFiles,
          binaries: binInventory,
        });
        const dependencies = {
          ...manifest.dependencies,
          ...manifest.optionalDependencies,
          ...manifest.devDependencies,
        };
        if (Object.values(dependencies).some((value) => /(?:file:|workspace:|link:)/u.test(String(value))))
          result.localReferenceManifests.push(relative);
      }
    }
  }
  await walk(directory);
  result.fileTreeSha256 = hash(fileDigests.join('\n'));
  return result;
}
function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}
