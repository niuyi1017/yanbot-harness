import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, rename, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { extractRuntimeArchive, sha256 } from './archive.mjs';
import { inspectCandidate } from './inventory.mjs';
import { TARGETS, TRUSTED_KEYS, VERSION, verifyPlatformPackage } from './manifest.mjs';
import { privateDirectory } from './permissions.mjs';

export class RuntimeResolutionError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'RuntimeResolutionError';
    this.reason = reason;
  }
}

export function currentTarget() {
  if (!/^22\.(?:2[2-9]|[3-9][0-9]|[1-9][0-9]{2,})\.[0-9]+$/u.test(process.versions.node)) {
    throw new RuntimeResolutionError('NODE_UNSUPPORTED', 'Use Node >=22.22.0 <23.');
  }
  const target = TARGETS[process.platform + '-' + process.arch];
  if (!target || (target.libc && !process.report.getReport().header.glibcVersionRuntime)) {
    throw new RuntimeResolutionError(
      'UNSUPPORTED_TARGET',
      'Supported Node targets: darwin-arm64, win32-x64, linux-x64 glibc. Rosetta x64 Node is not supported.',
    );
  }
  if (process.versions.electron)
    throw new RuntimeResolutionError(
      'NODE_UNSUPPORTED',
      'Use a certified plain Node host, not Electron process.execPath.',
    );
  return target;
}

function defaultCacheRoot() {
  if (process.platform === 'darwin') return path.join(homedir(), 'Library/Caches/YanbotHarness/runtimes');
  if (process.platform === 'win32') {
    assert(process.env.LOCALAPPDATA && path.isAbsolute(process.env.LOCALAPPDATA), 'LOCALAPPDATA missing.');
    return path.join(process.env.LOCALAPPDATA, 'YanbotHarness/Cache/runtimes');
  }
  const xdg = process.env.XDG_CACHE_HOME;
  return path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(homedir(), '.cache'), 'yanbot-harness/runtimes');
}

// Host-supplied keys are an explicit trust override. Never load a key from a platform package.
export async function resolveInstalledRuntime(options = {}) {
  const signal = options.signal ?? globalThis.AbortSignal.timeout(15000);
  signal.throwIfAborted();
  const target = currentTarget();
  const name = '@yanbot-harness/runtime-' + target.os + '-' + target.cpu;
  let manifestPath;
  try {
    manifestPath = createRequire(import.meta.url).resolve(name + '/manifest');
  } catch {
    throw new RuntimeResolutionError(
      'RUNTIME_PACKAGE_MISSING',
      'Install ' +
        name +
        '@' +
        VERSION +
        ' with optional dependencies enabled. Check Registry access, platform availability and the lockfile; no automatic download was attempted.',
    );
  }
  return resolvePlatformDirectory({ ...options, directory: path.dirname(manifestPath), target, signal });
}

// Internal entry for release verification and isolated tests; not exported through package exports.
export async function resolvePlatformDirectory({
  directory,
  target,
  signal = globalThis.AbortSignal.timeout(15000),
  cacheRoot,
  trustedKeys = TRUSTED_KEYS,
  expectedVersion = VERSION,
}) {
  let verified;
  try {
    signal.throwIfAborted();
    assert((await lstat(directory)).isDirectory(), 'Platform directory is not regular.');
    verified = await verifyPlatformPackage({ directory, target, expectedVersion, trustedKeys, signal });
    // Authenticate compressed bytes on cache hits too. A cache is not a replacement for the installed package.
    const archivePath = path.join(directory, verified.manifest.payload.path);
    assert((await lstat(archivePath)).isFile());
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of createReadStream(archivePath, { signal })) {
      bytes += chunk.length;
      assert(bytes <= verified.manifest.payload.size, 'Payload size limit.');
      hash.update(chunk);
    }
    assert(
      bytes === verified.manifest.payload.size && hash.digest('hex') === verified.manifest.payload.sha256,
      'Payload digest mismatch.',
    );
  } catch {
    if (signal.aborted) throw signal.reason;
    throw new RuntimeResolutionError(
      'INTEGRITY_FAILED',
      'Runtime signature, version, target or material integrity failed. Use the exact authorized release and trust root.',
    );
  }
  const { manifest, fileListBytes } = verified;
  let release;
  let temporary;
  try {
    const root = await privateDirectory(cacheRoot ?? defaultCacheRoot(), signal);
    const parent = await privateDirectory(path.join(root, manifest.version, target.os + '-' + target.cpu), signal);
    const destination = path.join(parent, manifest.payload.sha256);
    release = await cacheLock(destination, signal);
    let exists = false;
    try {
      exists = (await lstat(destination)).isDirectory();
      assert(exists, 'Cache root is not a directory.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (!exists) {
      temporary = await extractRuntimeArchive({
        archivePath: path.join(directory, manifest.payload.path),
        fileListBytes,
        fileList: {
          size: manifest.fileList.size,
          sha256: manifest.fileList.sha256,
          entryCount: manifest.fileList.entryCount,
        },
        payload: { size: manifest.payload.size, sha256: manifest.payload.sha256 },
        outputParent: parent,
        signal,
      });
      signal.throwIfAborted();
      await rename(temporary.directory, destination);
    }
    signal.throwIfAborted();
    const actual = await inspectCandidate(destination, { scan: false, signal });
    assert.equal(
      actual.sha256,
      manifest.fileList.sha256,
      'Cache corruption; use a fresh cacheRoot. Existing bytes were preserved.',
    );
    signal.throwIfAborted();
    return {
      entryPath: path.join(destination, manifest.entryPath),
      runtimeVersion: manifest.version,
      protocolVersion: manifest.protocolVersion,
      managedProtocolVersion: 1,
    };
  } catch {
    if (signal.aborted) throw signal.reason;
    throw new RuntimeResolutionError(
      'CACHE_UNAVAILABLE',
      'Cannot verify or create the private Runtime cache. Check permissions, available space, local lock policy, and timeout; use a fresh cacheRoot for corrupt content.',
    );
  } finally {
    if (temporary) await rm(temporary.root, { recursive: true, force: true });
    if (release) await release();
  }
}

async function cacheLock(identity, signal) {
  const port = 35000 + (Number.parseInt(sha256(identity).slice(0, 8), 16) % 25000);
  while (true) {
    signal.throwIfAborted();
    const server = createServer((socket) => socket.destroy());
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen({ host: '127.0.0.1', port, exclusive: true }, resolve);
      });
      if (signal.aborted) {
        await new Promise((resolve) => server.close(resolve));
        signal.throwIfAborted();
      }
      return () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
      await delay(50, undefined, { signal });
    }
  }
}
