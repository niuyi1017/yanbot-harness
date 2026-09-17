import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { fileSha256, validateArchiveEntries, verifyChecksums } from './lib/internal-delivery.mjs';
import { extractRuntimeArchive, listZipArchiveEntries } from './lib/release-platform.mjs';

const execute = promisify(execFile);
const args = process.argv.slice(2).filter((item) => item !== '--');
assert(
  args.length === 4 && args[0] === '--archive' && args[2] === '--output',
  'Use --archive DELIVERY_ZIP --output REPORT_FILE.',
);
const archive = path.resolve(args[1]);
const output = path.resolve(args[3]);
assert((await lstat(archive)).isFile(), 'Delivery archive must be a regular file.');
const archiveName = path.basename(archive);
assert(archiveName.endsWith('.zip'), 'Delivery archive must be a ZIP.');
const rootName = archiveName.slice(0, -4);
const expectedTarget = process.platform + '-' + process.arch;
const temporary = await mkdtemp(path.join(tmpdir(), 'harness-delivery-验证 path & #-'));

try {
  const entries = await listZipArchiveEntries(archive);
  validateArchiveEntries(entries, rootName);
  const extracted = path.join(temporary, 'extracted');
  await mkdir(extracted);
  await extractRuntimeArchive(archive, extracted);
  const root = path.join(extracted, rootName);
  await verifyChecksums(root);
  const manifest = JSON.parse(await readFile(path.join(root, 'delivery-manifest.json'), 'utf8'));
  assert.equal(manifest.kind, 'yanbot-harness-internal-test-delivery');
  assert.equal(manifest.target, expectedTarget, 'Delivery target does not match this verification host.');
  assert.equal(manifest.rootPackage, '@yanbot-harness/local');
  assert.equal(manifest.testSigning, true);
  assert.equal(manifest.productionAuthorized, false);
  const prefix = path.join(temporary, '安装 consumer space & #');
  const { stdout } = await execute(process.execPath, [path.join(root, 'install.mjs'), '--prefix', prefix], {
    cwd: root,
    env: process.env,
    timeout: 360000,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  const installation = JSON.parse(stdout.trim().split(/\r?\n/u).at(-1));
  assert.equal(installation.status, 'passed');
  assert.equal(installation.target, expectedTarget);
  assert.equal(installation.rootPackage, '@yanbot-harness/local');
  assert.equal(installation.reference.terminal, 'run.completed');
  const report = {
    schemaVersion: 1,
    kind: 'internal-test-delivery-verification',
    status: 'passed',
    version: manifest.version,
    target: manifest.target,
    sourceCommit: manifest.sourceCommit,
    rootPackage: manifest.rootPackage,
    artifact: {
      file: archiveName,
      size: (await lstat(archive)).size,
      sha256: await fileSha256(archive),
    },
    verification: {
      zipEntryPolicy: 'passed',
      allFileChecksums: 'passed',
      freshPathWithSpacesAndChinese: 'passed',
      emptyNpmCache: installation.emptyNpmCache,
      offline: installation.offline,
      ignoreInstallScripts: installation.ignoreScripts,
      finalDirectDependencies: ['@yanbot-harness/local'],
      reference: installation.reference,
    },
    testSigning: true,
    productionAuthorized: false,
  };
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(report));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
