import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { Buffer } from 'node:buffer';

// Explicit development fixture builder. No fetching, no production trust claim, no host-side guest execution.
const args = process.argv.slice(2);
const panicProbe = args.includes('--panic-probe');
if (panicProbe) args.splice(args.indexOf('--panic-probe'), 1);
const [kernelFile, initrdFile, outputDirectory, runtimeRoot] = args;
assert(!panicProbe || !runtimeRoot, 'Kernel panic injection is restricted to the explicit mechanism guest.');
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
${
  panicProbe
    ? `/bin/busybox setsid /bin/busybox sh -c 'echo HARNESS_DETACHED_READY; while :; do /bin/busybox sleep 1; done' &
echo HARNESS_GUEST_READY
echo HARNESS_GUEST_TICK
/bin/busybox sleep 1
echo c >/proc/sysrq-trigger
`
    : ''
}
${
  runtimeRoot
    ? `/bin/busybox mkdir -p /harness-shares /harness-home /tmp
/bin/busybox chmod 1777 /tmp
kernel_version=$(/bin/busybox uname -r)
for module in vsock vmw_vsock_virtio_transport_common vmw_vsock_virtio_transport; do
  /bin/busybox insmod "/lib/modules/$kernel_version/kernel/net/vmw_vsock/$module.ko" || {
    echo HARNESS_RUNTIME_EXIT
    /bin/busybox poweroff -f
  }
done
/bin/busybox modprobe virtiofs
/bin/busybox mount -t virtiofs harness-shares /harness-shares
/bin/busybox ip link set lo up
/bin/busybox modprobe virtio_net 2>/dev/null
if [ -d /sys/class/net/eth0 ]; then
  /bin/busybox udhcpc -i eth0 -n -q -t 3 -T 2 -s /harness-dhcp >/dev/null 2>&1 || {
    echo HARNESS_RUNTIME_EXIT
    /bin/busybox poweroff -f
  }
fi
/harness/bin/vsock-bridge &
/harness/bin/node /harness/runtime-agent.mjs
echo HARNESS_RUNTIME_EXIT
/bin/busybox poweroff -f
`
    : ''
}
/bin/busybox setsid /bin/busybox sh -c 'echo HARNESS_DETACHED_READY; while :; do /bin/busybox sleep 1; done' &
echo HARNESS_GUEST_READY
while :; do /bin/busybox sleep 1; done
`);
const entries = [];
if (runtimeRoot)
  entries.push(
    entry(
      'harness-dhcp',
      Buffer.from(`#!/bin/busybox sh
case "$1" in
  bound|renew)
    /bin/busybox ifconfig "$interface" "$ip" netmask "$subnet" up
    for gateway in $router; do /bin/busybox route add default gw "$gateway" dev "$interface"; break; done
    : >/etc/resolv.conf
    for server in $dns; do echo "nameserver $server" >>/etc/resolv.conf; done
    ;;
esac
`),
      0o100755,
    ),
  );
let rootBytes = 0;
let fixtureGuestAgentSha256;
if (runtimeRoot) {
  async function collect(relative) {
    const absolute = path.join(runtimeRoot, relative);
    const info = await lstat(absolute);
    assert(!info.isSymbolicLink(), 'Development guest root must contain only real files/directories.');
    assert(!relative.split('/').some((part) => part === '..') && !path.isAbsolute(relative));
    if (info.isDirectory()) {
      if (relative) entries.push(entry(relative, Buffer.alloc(0), 0o040755));
      for (const name of (await readdir(absolute)).sort()) await collect(relative ? relative + '/' + name : name);
    } else {
      assert(info.isFile() && info.size <= 160 * 1024 * 1024);
      rootBytes += info.size;
      assert(rootBytes <= 512 * 1024 * 1024 && entries.length < 20000);
      // The wrapper belongs to this image build, not the separately compiled Runtime root artifact.
      const bytes = await readFile(
        relative === 'harness/runtime-agent.mjs'
          ? path.resolve(import.meta.dirname, '../native/guest/runtime-agent.mjs')
          : absolute,
      );
      if (relative === 'harness/runtime-agent.mjs') fixtureGuestAgentSha256 = sha256(bytes);
      entries.push(entry(relative, bytes, info.mode & 0o111 ? 0o100755 : 0o100644));
    }
  }
  await collect('');
}
const extra = Buffer.concat([
  ...entries,
  entry('harness-init', init, 0o100755),
  entry('TRAILER!!!', Buffer.alloc(0), 0),
]);
const combined = Buffer.concat([original, gzipSync(extra, { level: 9, mtime: 0 })]);
await writeFile(path.join(output, 'kernel'), kernel, { flag: 'wx' });
await writeFile(path.join(output, 'initrd'), combined, { flag: 'wx' });
const config = {
  schemaVersion: 1,
  kernel: { path: path.join(output, 'kernel'), sha256: sha256(kernel) },
  initrd: { path: path.join(output, 'initrd'), sha256: sha256(combined) },
  ...(runtimeRoot || panicProbe ? { runtime: { shares: [], network: false } } : {}),
};
await writeFile(path.join(output, 'config.json'), JSON.stringify(config, null, 2) + '\n', { flag: 'wx' });
await writeFile(
  path.join(output, 'guest-provenance.json'),
  JSON.stringify(
    {
      schemaVersion: 1,
      guestTarget: 'linux-arm64',
      kind: runtimeRoot
        ? 'runtime-development-guest'
        : panicProbe
          ? 'kernel-panic-mechanism-fixture'
          : 'mechanism-fixture-not-runtime',
      runtimeRootBytes: rootBytes,
      ...(fixtureGuestAgentSha256 ? { fixtureGuestAgentSha256 } : {}),
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
