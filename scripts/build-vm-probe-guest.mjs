import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { Buffer } from 'node:buffer';

// Explicit development fixture builder. No fetching, no production trust claim, no host-side guest execution.
const [kernelFile, initrdFile, outputDirectory] = process.argv.slice(2);
assert(
  kernelFile && initrdFile && outputDirectory,
  'Provide pre-staged arm64 Linux kernel, initramfs and NEW output directory.',
);
const output = path.resolve(outputDirectory);
await mkdir(output, { mode: 0o700 });
const sourceKernel = await readFile(kernelFile);
let kernel = sourceKernel;
const original = await readFile(initrdFile);
assert(kernel.length < 32 * 1024 * 1024 && original.length < 32 * 1024 * 1024);
// Linux EFI zboot header: fixed payload offset/size at 8/12, compression name at 24.
if (kernel.length >= 64 && kernel.subarray(4, 8).toString() === 'zimg') {
  assert.equal(kernel.subarray(24, 29).toString(), 'gzip\0');
  const offset = kernel.readUInt32LE(8);
  const size = kernel.readUInt32LE(12);
  assert(offset >= 64 && size > 18 && offset + size <= kernel.length, 'Truncated zboot payload.');
  kernel = gunzipSync(kernel.subarray(offset, offset + size), { maxOutputLength: 128 * 1024 * 1024 });
}
assert(kernel.length >= 64 && kernel.readUInt32LE(56) === 0x644d5241, 'An ARM64 Linux Image is required.');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
function entry(name, bytes, mode) {
  const filename = Buffer.from(name + '\0');
  const fields = [1, mode, 0, 0, 1, 0, bytes.length, 0, 0, 0, 0, filename.length, 0];
  const header = Buffer.from('070701' + fields.map((value) => value.toString(16).padStart(8, '0')).join(''));
  const pad = (length) => Buffer.alloc((4 - (length % 4)) % 4);
  return Buffer.concat([header, filename, pad(header.length + filename.length), bytes, pad(bytes.length)]);
}
const init = Buffer.from(`#!/bin/busybox sh
export PATH=/bin:/sbin:/usr/bin:/usr/sbin
/bin/busybox mkdir -p /dev
/bin/busybox mount -t devtmpfs devtmpfs /dev
exec </dev/console >/dev/console 2>&1
/bin/busybox mount -t proc proc /proc
/bin/busybox mount -t sysfs sysfs /sys
/bin/busybox setsid /bin/busybox sh -c 'echo HARNESS_DETACHED_READY; while :; do /bin/busybox sleep 1; done' &
echo HARNESS_GUEST_READY
while :; do /bin/busybox sleep 1; done
`);
const extra = Buffer.concat([entry('harness-init', init, 0o100755), entry('TRAILER!!!', Buffer.alloc(0), 0)]);
const combined = Buffer.concat([original, gzipSync(extra, { level: 9, mtime: 0 })]);
await writeFile(path.join(output, 'kernel'), kernel, { flag: 'wx' });
await writeFile(path.join(output, 'initrd'), combined, { flag: 'wx' });
const config = {
  schemaVersion: 1,
  kernel: { path: path.join(output, 'kernel'), sha256: sha256(kernel) },
  initrd: { path: path.join(output, 'initrd'), sha256: sha256(combined) },
};
await writeFile(path.join(output, 'config.json'), JSON.stringify(config, null, 2) + '\n', { flag: 'wx' });
await writeFile(
  path.join(output, 'guest-provenance.json'),
  JSON.stringify(
    {
      schemaVersion: 1,
      guestTarget: 'linux-arm64',
      kind: 'mechanism-fixture-not-runtime',
      productionTrusted: false,
      sourceKernelSha256: sha256(sourceKernel),
      normalizedKernelSha256: sha256(kernel),
      sourceInitrdSha256: sha256(original),
      fixtureInitSha256: sha256(init),
      config,
    },
    null,
    2,
  ) + '\n',
  { flag: 'wx' },
);
console.log(JSON.stringify({ config: path.join(output, 'config.json'), productionTrusted: false }));
