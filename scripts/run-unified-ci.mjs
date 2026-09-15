import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const [commonParent, platformParent, outputFile] = process.argv.slice(2);
assert(commonParent && platformParent && outputFile, 'Use COMMON_PARENT PLATFORM_PARENT REPORT_POINTER.');
async function locate(parent, marker) {
  const candidates = [
    path.resolve(parent),
    ...(await readdir(parent, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(path.resolve(parent), entry.name)),
  ];
  const matches = [];
  for (const directory of candidates) {
    try {
      JSON.parse(await readFile(path.join(directory, marker), 'utf8'));
      matches.push(directory);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  assert.equal(matches.length, 1, 'Expected one artifact set.');
  return matches[0];
}
const common = await locate(commonParent, 'common-manifest.json');
const platform = await locate(platformParent, 'build-report.json');
async function capture(stdout) {
  process.stdout.write(stdout);
  const result = JSON.parse(stdout.trim().split(/\r?\n/u).at(-1));
  await copyFile(path.join(result.directory, 'installation-report.json'), path.resolve(outputFile));
}
try {
  const result = await execute(
    process.execPath,
    [path.join(import.meta.dirname, 'test-unified-installation.mjs'), '--common', common, '--platform', platform],
    { env: process.env, timeout: 900000, maxBuffer: 8192 },
  );
  await capture(result.stdout);
} catch (error) {
  if (error.stdout) await capture(error.stdout);
  process.stderr.write(error.stderr ?? 'Unified installation failed.');
  process.exitCode = 1;
}
