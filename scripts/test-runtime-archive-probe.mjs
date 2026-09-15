import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { gzipSync, gunzipSync } from 'node:zlib';

import {
  ARCHIVE_LIMITS,
  encodeFileList,
  extractRuntimeArchive,
  packRuntimeArchive,
  sha256,
  UstarGate,
  validateFileList,
} from './lib/runtime-archive-probe.mjs';
import { inspectCandidate } from './lib/normalize-runtime-staging.mjs';

const file = (name, body = Buffer.from('abc')) => ({
  path: name,
  type: 'file',
  size: body.length,
  sha256: sha256(body),
  executable: false,
});
const listMetadata = (bytes, count) => ({ size: bytes.length, sha256: sha256(bytes), entryCount: count });

async function setup(t, content = 'abc') {
  const root = await mkdtemp(path.join(tmpdir(), 'harness-archive-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  await mkdir(source);
  await writeFile(path.join(source, 'a.txt'), content);
  const pack = await packRuntimeArchive({ source, outputDirectory: path.join(root, 'packed') });
  const original = await readFile(pack.archivePath);
  const outputParent = path.join(root, '输出 space &');
  await mkdir(outputParent);
  await writeFile(path.join(outputParent, 'keep.txt'), 'keep');
  let sequence = 0;
  async function extract(bytes = original, entries, extras = {}) {
    const archivePath = path.join(root, `input-${sequence++}.gz`);
    await writeFile(archivePath, bytes);
    const fileListBytes = entries ? encodeFileList(entries) : pack.fileListBytes;
    const fileList = entries ? listMetadata(fileListBytes, entries.length) : pack.fileList;
    return extractRuntimeArchive({
      archivePath,
      fileListBytes,
      fileList,
      payload: { size: bytes.length, sha256: sha256(bytes) },
      outputParent,
      ...extras,
    });
  }
  async function reject(bytes, entries, pattern = /./u, extras) {
    await assert.rejects(extract(bytes, entries, extras), pattern);
    assert.deepEqual(await readdir(outputParent), ['keep.txt']);
    assert.equal(await readFile(path.join(outputParent, 'keep.txt'), 'utf8'), 'keep');
  }
  return { root, source, pack, original, outputParent, extract, reject };
}

function mutateHeader(tarBytes, mutation) {
  const bytes = Buffer.from(tarBytes);
  mutation(bytes.subarray(0, 512));
  bytes.fill(32, 148, 156);
  const checksum = bytes.subarray(0, 512).reduce((sum, byte) => sum + byte, 0);
  bytes.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return bytes;
}

test('archive round-trip preserves bytes/modes, uses a private unique destination and is repeatable', async (t) => {
  const f = await setup(t);
  const before = await inspectCandidate(f.source);
  const result = await f.extract();
  assert.equal((await inspectCandidate(result.directory)).sha256, before.sha256);
  assert.equal(result.fileCount, 1);
  const second = await packRuntimeArchive({ source: f.source, outputDirectory: path.join(f.root, 'second') });
  assert.deepEqual(await readFile(second.archivePath), f.original);
  const another = await f.extract();
  assert.notEqual(another.directory, result.directory);
  assert.equal(await readFile(path.join(result.directory, 'a.txt'), 'utf8'), 'abc');
});

test('empty archive and explicit empty directories are accepted', async (t) => {
  const f = await setup(t);
  const empty = gzipSync(Buffer.alloc(1024));
  const result = await f.extract(empty, []);
  assert.deepEqual(await readdir(result.directory), []);
  const source = path.join(f.root, 'empty-source');
  await mkdir(path.join(source, 'empty'), { recursive: true });
  const packed = await packRuntimeArchive({ source, outputDirectory: path.join(f.root, 'empty-packed') });
  const unpacked = await f.extract(await readFile(packed.archivePath), [{ path: 'empty', type: 'directory' }]);
  assert((await stat(path.join(unpacked.directory, 'empty'))).isDirectory());
});

test('builder refuses an existing directory without overwriting and rejects PAX-requiring internal names', async (t) => {
  const f = await setup(t);
  await assert.rejects(packRuntimeArchive({ source: f.source, outputDirectory: path.join(f.root, 'packed') }), {
    code: 'EEXIST',
  });
  assert.deepEqual(await readFile(f.pack.archivePath), f.original);
  await writeFile(path.join(f.source, '中文.txt'), 'resource');
  const output = path.join(f.root, 'unsupported');
  await assert.rejects(packRuntimeArchive({ source: f.source, outputDirectory: output }), /tar type/u);
  await assert.rejects(stat(output), { code: 'ENOENT' });
});

test('file list rejects traversal, ADS, Windows characters/reserved names and collisions before I/O', () => {
  const validate = (entries) => {
    const bytes = encodeFileList(entries);
    return validateFileList(bytes, listMetadata(bytes, entries.length));
  };
  for (const name of [
    '../escape',
    '/absolute',
    'C:drive',
    'a\\b',
    'CON',
    'a?',
    'a*',
    'a|b',
    'a<',
    'a>',
    'a"',
    'a.',
    'a ',
    'a\0b',
    'x'.repeat(1025),
  ])
    assert.throws(() => validate([file(name)]));
  assert.throws(() => validate([file('A'), file('a')]), /colliding/u);
  assert.throws(() => validate([file('a'), file('a')]), /colliding/u);
  assert.throws(() => validate([file('e\u0301'), file('é')]), /colliding/u);
  assert.throws(() => validate([file('parent/child')]), /parent/u);
  assert.throws(() => validate([file('a'), file('a/b')]), /parent/u);
  assert.throws(() => validate([{ path: 'Parent', type: 'directory' }, file('parent/a')]), /parent/u);
});

test('file list enforces digest, canonical JSON, schema and resource limits', () => {
  const valid = encodeFileList([file('a')]);
  assert.throws(() => validateFileList(valid, { ...listMetadata(valid, 1), sha256: '0'.repeat(64) }), /digest/u);
  for (const entries of [
    [{ ...file('a'), size: -1 }],
    [{ ...file('a'), size: ARCHIVE_LIMITS.fileBytes + 1 }],
    [file('b'), file('a')],
    [{ ...file('a'), extra: true }],
    [{ path: 'a', type: 'symlink' }],
    [0, 1, 2].map((n) => ({ ...file(String(n)), size: ARCHIVE_LIMITS.fileBytes })),
  ]) {
    const bytes = encodeFileList(entries);
    assert.throws(() => validateFileList(bytes, listMetadata(bytes, entries.length)));
  }
  for (const text of [
    valid.toString().replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
    valid.toString().replace('"size":3', '"size":3.0'),
  ]) {
    const bytes = Buffer.from(text);
    assert.throws(() => validateFileList(bytes, listMetadata(bytes, 1)), /Noncanonical/u);
  }
  const tooLarge = Buffer.alloc(ARCHIVE_LIMITS.fileListBytes + 1);
  assert.throws(() => validateFileList(tooLarge, {}), /limit/u);
  const tooMany = encodeFileList(Array(ARCHIVE_LIMITS.entries + 1).fill(null));
  assert.throws(() => validateFileList(tooMany, listMetadata(tooMany, ARCHIVE_LIMITS.entries + 1)), /Entry limit/u);
});

test('compression digest and compressed size limits reject before extraction', async (t) => {
  const f = await setup(t);
  await f.reject(f.original, undefined, /digest/u, { payload: { size: f.original.length, sha256: '0'.repeat(64) } });
  await f.reject(f.original, undefined, /size limit/u, {
    payload: { size: ARCHIVE_LIMITS.compressedBytes + 1, sha256: '0'.repeat(64) },
  });
});

for (const [name, mutation] of [
  [
    'traversal',
    (h) => {
      h.fill(0, 0, 100);
      h.write('../escape');
    },
  ],
  [
    'absolute path',
    (h) => {
      h.fill(0, 0, 100);
      h.write('/tmp/escape');
    },
  ],
  [
    'symlink',
    (h) => {
      h[156] = 50;
      h.write('../escape', 157);
    },
  ],
  [
    'hardlink',
    (h) => {
      h[156] = 49;
      h.write('../escape', 157);
    },
  ],
  [
    'PAX',
    (h) => {
      h[156] = 120;
    },
  ],
  [
    'global PAX',
    (h) => {
      h[156] = 103;
    },
  ],
  [
    'GNU long path',
    (h) => {
      h[156] = 76;
    },
  ],
  [
    'GNU long link',
    (h) => {
      h[156] = 75;
    },
  ],
  [
    'sparse',
    (h) => {
      h[156] = 83;
    },
  ],
  [
    'device',
    (h) => {
      h[156] = 51;
    },
  ],
  [
    'FIFO',
    (h) => {
      h[156] = 54;
    },
  ],
  [
    'huge size',
    (h) => {
      h.write('77777777777 ', 124);
    },
  ],
  [
    'negative size',
    (h) => {
      h.write('-0000000001 ', 124);
    },
  ],
  [
    'base256 size',
    (h) => {
      h[124] = 128;
    },
  ],
  [
    'setuid mode',
    (h) => {
      h.write('004644 \0', 100);
    },
  ],
  [
    'hidden suffix',
    (h) => {
      h[10] = 1;
    },
  ],
])
  test(`rejects ${name} before parser/filesystem write`, async (t) => {
    const f = await setup(t);
    await f.reject(gzipSync(mutateHeader(gunzipSync(f.original), mutation)));
    await assert.rejects(stat(path.join(f.root, 'escape')), { code: 'ENOENT' });
  });

test('rejects checksum, file digest, nonzero padding, truncation, missing entries and duplicate/trailing entries', async (t) => {
  const f = await setup(t);
  const raw = gunzipSync(f.original);
  const checksum = Buffer.from(raw);
  checksum[148] ^= 1;
  await f.reject(gzipSync(checksum), undefined, /checksum/u);
  const content = Buffer.from(raw);
  content[512] ^= 1;
  await f.reject(gzipSync(content), undefined, /digest/u);
  const padding = Buffer.from(raw);
  padding[520] = 1;
  await f.reject(gzipSync(padding), undefined, /padding/u);
  for (const length of [0, 200, 513, raw.length - 512, raw.length - 1])
    await f.reject(gzipSync(raw.subarray(0, length)));
  await f.reject(gzipSync(Buffer.alloc(1024)));
  await f.reject(gzipSync(Buffer.concat([raw.subarray(0, 1024), raw])));
  await f.reject(gzipSync(Buffer.concat([raw, Buffer.from('garbage')])));
});

test('rejects gzip CRC/ISIZE/truncation, optional headers, trailing bytes and concatenated members', async (t) => {
  const f = await setup(t);
  for (const offset of [f.original.length - 8, f.original.length - 4, 3]) {
    const bytes = Buffer.from(f.original);
    bytes[offset] ^= 1;
    await f.reject(bytes);
  }
  await f.reject(f.original.subarray(0, f.original.length - 3));
  for (const suffix of [Buffer.from([0]), Buffer.from('extra'), gzipSync(Buffer.alloc(0)), f.original])
    await f.reject(Buffer.concat([f.original, suffix]));
});

test('expansion bomb and byte-fragmented framing stay bounded', async (t) => {
  const f = await setup(t);
  await f.reject(gzipSync(Buffer.alloc(4 * 1024 * 1024)), undefined, /excessive/u);
  const raw = gunzipSync(f.original);
  const sink = new Writable({
    write(chunk, encoding, callback) {
      callback();
    },
  });
  await pipeline(Readable.from([...raw].map((byte) => Buffer.from([byte]))), new UstarGate([file('a.txt')]), sink);
});

test('already-aborted and timed-out operations leave no published payload or owned partial tree', async (t) => {
  const f = await setup(t, Buffer.alloc(8 * 1024 * 1024));
  const controller = new globalThis.AbortController();
  controller.abort();
  await f.reject(f.original, undefined, /abort/iu, { signal: controller.signal });
  await f.reject(f.original, undefined, /abort|timeout/iu, { signal: globalThis.AbortSignal.timeout(1) });
});

test('cancellation after staging begins waits for writers and removes only its owned container', async (t) => {
  const f = await setup(t, Buffer.alloc(16 * 1024 * 1024));
  const controller = new globalThis.AbortController();
  let observed = false;
  const watch = (async () => {
    for (let attempt = 0; attempt < 1000; attempt++) {
      for (const name of await readdir(f.outputParent)) {
        if (!name.startsWith('.archive-probe-')) continue;
        try {
          if ((await stat(path.join(f.outputParent, name, 'staging/a.txt'))).size > 0) {
            observed = true;
            controller.abort();
            return;
          }
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
      await delay(1);
    }
    controller.abort();
  })();
  await f.reject(f.original, undefined, /abort/iu, { signal: controller.signal });
  await watch;
  assert(observed, 'Cancellation test must observe an active extracted file.');
  await delay(20);
  assert.deepEqual(await readdir(f.outputParent), ['keep.txt']);
});

test('concurrent probes own separate destinations and unusable output parents do not damage existing files', async (t) => {
  const f = await setup(t);
  const [first, second] = await Promise.all([f.extract(), f.extract()]);
  assert.notEqual(first.directory, second.directory);
  for (const result of [first, second])
    assert.equal(await readFile(path.join(result.directory, 'a.txt'), 'utf8'), 'abc');
  const sentinel = path.join(f.outputParent, 'keep.txt');
  await assert.rejects(f.extract(f.original, undefined, { outputParent: sentinel }));
  assert.equal(await readFile(sentinel, 'utf8'), 'keep');
});
