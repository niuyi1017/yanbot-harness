import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
const execute = promisify(execFile);
assert(process.platform === 'darwin' && process.arch === 'arm64');
const output = path.resolve(process.argv[2] ?? 'native-build');
await mkdir(output, { recursive: true });
const source = path.resolve(import.meta.dirname, '../native/macos');
const binary = path.join(output, 'managed-vm-host');
await execute(
  '/usr/bin/xcrun',
  [
    'swiftc',
    '-parse-as-library',
    '-swift-version',
    '5',
    '-O',
    '-target',
    'arm64-apple-macos12.0',
    '-framework',
    'Virtualization',
    path.join(source, 'ManagedVMHost.swift'),
    '-o',
    binary,
  ],
  { timeout: 120000, maxBuffer: 1024 * 1024 },
);
await execute(
  '/usr/bin/codesign',
  ['--sign', '-', '--entitlements', path.join(source, 'virtualization.entitlements'), binary],
  { timeout: 30000 },
);
await execute('/usr/bin/codesign', ['--verify', '--strict', binary], { timeout: 30000 });
const capabilities = JSON.parse((await execute(binary, ['--capabilities'], { timeout: 10000 })).stdout);
const bytes = await readFile(binary);
const report = {
  schemaVersion: 1,
  target: 'darwin-arm64',
  signature: 'ad-hoc-test-only',
  sha256: createHash('sha256').update(bytes).digest('hex'),
  capabilities,
  guestBootTested: false,
};
await writeFile(path.join(output, 'macos-vm-build.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
