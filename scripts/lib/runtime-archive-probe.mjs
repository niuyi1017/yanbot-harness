// T1d only: trusted test digests, not a production resolver, signature verifier or shared cache.
import assert from 'node:assert/strict';
import { Buffer, isUtf8 } from 'node:buffer';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip, createInflateRaw, crc32 } from 'node:zlib';

import tar from 'tar-stream';

import { CANDIDATE_LIMITS, inspectCandidate, validateCandidatePath } from './normalize-runtime-staging.mjs';

export const ARCHIVE_LIMITS = Object.freeze({ ...CANDIDATE_LIMITS, compressedBytes: 128 * 1024 * 1024 });
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const zero = Buffer.alloc(1024);
const noOp = () => {};

export function encodeFileList(entries) {
  return Buffer.from(`${JSON.stringify({ schemaVersion: 1, entries })}\n`);
}

export function validateFileList(bytes, expected) {
  assert(Buffer.isBuffer(bytes) && bytes.length <= ARCHIVE_LIMITS.fileListBytes, 'File list limit.');
  assert.equal(bytes.length, expected.size, 'File list size mismatch.');
  assert.equal(sha256(bytes), expected.sha256, 'File list digest mismatch.');
  assert(isUtf8(bytes), 'File list encoding.');
  const value = JSON.parse(bytes.toString('utf8'));
  assert(value?.schemaVersion === 1 && Array.isArray(value.entries), 'File list schema.');
  assert.equal(value.entries.length, expected.entryCount, 'File list count mismatch.');
  assert(value.entries.length <= ARCHIVE_LIMITS.entries, 'Entry limit.');
  const entries = [];
  const seen = new Map();
  let totalBytes = 0;
  for (const item of value.entries) {
    assert(item && typeof item.path === 'string', 'Entry schema.');
    validateCandidatePath(item.path);
    assert(!/[<>"|?*]/u.test(item.path), 'Windows invalid filename.');
    const key = item.path.normalize('NFC').toLowerCase();
    assert(!seen.has(key), 'Duplicate/colliding path.');
    assert(entries.length === 0 || entries.at(-1).path < item.path, 'File list order.');
    const parent = path.posix.dirname(item.path);
    if (parent !== '.')
      assert.equal(seen.get(parent.normalize('NFC').toLowerCase())?.path, parent, 'Missing or aliased parent.');
    if (parent !== '.')
      assert.equal(seen.get(parent.normalize('NFC').toLowerCase())?.type, 'directory', 'Non-directory parent.');
    let entry;
    if (item.type === 'directory') entry = { path: item.path, type: 'directory' };
    else {
      assert.equal(item.type, 'file', 'Entry type.');
      assert(
        Number.isSafeInteger(item.size) && item.size >= 0 && item.size <= ARCHIVE_LIMITS.fileBytes,
        'File size limit.',
      );
      assert(typeof item.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(item.sha256), 'File digest.');
      assert(typeof item.executable === 'boolean', 'File mode.');
      totalBytes += item.size;
      assert(totalBytes <= ARCHIVE_LIMITS.totalBytes, 'Expanded byte limit.');
      entry = { path: item.path, type: 'file', size: item.size, sha256: item.sha256, executable: item.executable };
    }
    entries.push(entry);
    seen.set(key, entry);
  }
  // Byte equality rejects unknown/duplicate JSON keys, noncanonical numbers, BOMs and alternative ordering.
  assert(bytes.equals(encodeFileList(entries)), 'Noncanonical file list.');
  return entries;
}

// Only frame boundaries are interpreted here; tar-stream remains the tar decoder.
// Extension headers never reach it. Every accepted header agrees with the trusted inventory.
export class UstarGate extends Transform {
  constructor(entries) {
    super();
    this.entries = entries;
    this.index = 0;
    this.header = Buffer.alloc(512);
    this.headerBytes = 0;
    this.remaining = 0;
    this.padding = 0;
    this.endBytes = 0;
    this.bytes = 0;
    this.crc = 0;
    this.expectedBytes = entries.reduce(
      (n, e) => n + 512 + (e.type === 'file' ? Math.ceil(e.size / 512) * 512 : 0),
      1024,
    );
    assert(this.expectedBytes <= ARCHIVE_LIMITS.totalBytes + ARCHIVE_LIMITS.entries * 1024 + 1024, 'Tar stream limit.');
  }
  _transform(chunk, encoding, callback) {
    try {
      this.bytes += chunk.length;
      assert(this.bytes <= this.expectedBytes, 'Trailing or excessive tar bytes.');
      this.crc = crc32(chunk, this.crc);
      let offset = 0;
      while (offset < chunk.length) {
        if (this.remaining) {
          const size = Math.min(this.remaining, chunk.length - offset);
          this.push(chunk.subarray(offset, offset + size));
          offset += size;
          this.remaining -= size;
        } else if (this.padding) {
          const size = Math.min(this.padding, chunk.length - offset);
          assert(chunk.subarray(offset, offset + size).equals(zero.subarray(0, size)), 'Nonzero tar padding.');
          this.push(chunk.subarray(offset, offset + size));
          offset += size;
          this.padding -= size;
        } else if (this.index === this.entries.length) {
          const size = chunk.length - offset;
          assert(
            this.endBytes + size <= 1024 && chunk.subarray(offset).every((byte) => byte === 0),
            'Invalid tar end.',
          );
          this.push(chunk.subarray(offset));
          this.endBytes += size;
          offset += size;
        } else {
          const size = Math.min(512 - this.headerBytes, chunk.length - offset);
          chunk.copy(this.header, this.headerBytes, offset, offset + size);
          this.headerBytes += size;
          offset += size;
          if (this.headerBytes !== 512) continue;
          const entry = this.entries[this.index++];
          checkHeader(this.header, entry);
          this.push(Buffer.from(this.header));
          this.headerBytes = 0;
          this.remaining = entry.type === 'file' ? entry.size : 0;
          this.padding = (512 - (this.remaining % 512)) % 512;
        }
      }
      callback();
    } catch (error) {
      callback(error);
    }
  }
  _flush(callback) {
    try {
      assert(
        this.bytes === this.expectedBytes &&
          this.endBytes === 1024 &&
          this.headerBytes === 0 &&
          this.remaining === 0 &&
          this.padding === 0,
        'Truncated tar stream.',
      );
      callback();
    } catch (error) {
      callback(error);
    }
  }
}

function checkHeader(header, entry) {
  const text = (start, length) => {
    const bytes = header.subarray(start, start + length);
    const end = bytes.indexOf(0);
    if (end !== -1)
      assert(
        bytes.subarray(end).every((byte) => byte === 0),
        'Hidden header suffix.',
      );
    const content = end === -1 ? bytes : bytes.subarray(0, end);
    assert(isUtf8(content), 'Invalid header UTF-8.');
    return content.toString('utf8');
  };
  const octal = (start, length) => {
    const raw = header.subarray(start, start + length).toString('latin1');
    assert(/^[0-7]+ *$/u.test(raw.replaceAll('\0', ' ')), 'Non-octal tar field.');
    return Number.parseInt(raw, 8);
  };
  assert(header.subarray(257, 265).equals(Buffer.from('ustar\0' + '00')), 'Unsupported tar format.');
  assert.equal(header[156], entry.type === 'file' ? 48 : 53, 'Forbidden or mismatched tar type.');
  const prefix = text(345, 155);
  assert.equal((prefix ? `${prefix}/` : '') + text(0, 100), entry.path, 'Tar path mismatch.');
  const checksum = header.reduce((sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte), 0);
  assert.equal(octal(148, 8), checksum, 'Tar checksum mismatch.');
  assert.equal(octal(124, 12), entry.type === 'file' ? entry.size : 0, 'Tar size mismatch.');
  assert.equal(octal(100, 8), entry.type === 'directory' || entry.executable ? 0o755 : 0o644, 'Tar mode mismatch.');
  for (const [offset, length] of [
    [108, 8],
    [116, 8],
    [136, 12],
    [329, 8],
    [337, 8],
  ])
    assert.equal(octal(offset, length), 0, 'Noncanonical owner/time/device.');
  for (const [offset, length] of [
    [157, 100],
    [265, 32],
    [297, 32],
  ])
    assert.equal(text(offset, length), '', 'Unexpected link/owner.');
  assert(
    header.subarray(500).every((byte) => byte === 0),
    'Unexpected header suffix.',
  );
}

function meter(limit, expected) {
  let bytes = 0;
  const digest = createHash('sha256');
  return new Transform({
    transform(chunk, encoding, callback) {
      bytes += chunk.length;
      if (bytes > limit) return callback(new Error('Stream byte limit.'));
      digest.update(chunk);
      callback(null, chunk);
    },
    flush(callback) {
      try {
        const result = { size: bytes, sha256: digest.digest('hex') };
        if (expected) assert.deepEqual(result, expected, 'Stream size/digest mismatch.');
        this.result = result;
        callback();
      } catch (error) {
        callback(error);
      }
    },
  });
}

export async function packRuntimeArchive({ source, outputDirectory, signal }) {
  signal?.throwIfAborted();
  const inventory = await inspectCandidate(source);
  signal?.throwIfAborted();
  const fileListBytes = encodeFileList(inventory.entries);
  const fileList = { size: fileListBytes.length, sha256: sha256(fileListBytes), entryCount: inventory.entries.length };
  const entries = validateFileList(fileListBytes, fileList);
  await mkdir(outputDirectory, { mode: 0o700 }); // exclusive, never reuse another output directory
  const archivePath = path.join(outputDirectory, 'runtime.tar.gz');
  const pack = tar.pack();
  const counter = meter(ARCHIVE_LIMITS.compressedBytes);
  const pipe = pipeline(
    pack,
    new UstarGate(entries),
    createGzip({ level: 9 }),
    counter,
    createWriteStream(archivePath, { flags: 'wx', mode: 0o600 }),
    { signal },
  );
  pipe.catch(noOp);
  try {
    for (const entry of entries) {
      signal?.throwIfAborted();
      const header = {
        name: entry.path,
        type: entry.type,
        size: entry.type === 'file' ? entry.size : 0,
        mode: entry.type === 'directory' || entry.executable ? 0o755 : 0o644,
        uid: 0,
        gid: 0,
        mtime: new Date(0),
      };
      if (entry.type === 'directory')
        await new Promise((resolve, reject) => pack.entry(header, (error) => (error ? reject(error) : resolve())));
      else {
        const input = path.join(source, entry.path);
        assert((await lstat(input)).isFile(), 'Source changed to a link.');
        await pipeline(
          createReadStream(input),
          meter(entry.size, { size: entry.size, sha256: entry.sha256 }),
          pack.entry(header),
          { signal },
        );
      }
    }
    pack.finalize();
    await pipe;
    signal?.throwIfAborted();
    await writeFile(path.join(outputDirectory, 'files.json'), fileListBytes, { flag: 'wx', mode: 0o600 });
    signal?.throwIfAborted();
    return { archivePath, fileListBytes, fileList, payload: counter.result };
  } catch (error) {
    pack.destroy(error);
    await pipe.catch(noOp);
    await rm(outputDirectory, { recursive: true, force: true });
    throw error;
  }
}

export async function extractRuntimeArchive({ archivePath, fileListBytes, fileList, payload, outputParent, signal }) {
  signal?.throwIfAborted();
  const entries = validateFileList(fileListBytes, fileList);
  assert(
    Number.isSafeInteger(payload.size) && payload.size >= 18 && payload.size <= ARCHIVE_LIMITS.compressedBytes,
    'Compressed size limit.',
  );
  assert(/^[a-f0-9]{64}$/u.test(payload.sha256), 'Payload digest format.');
  assert((await lstat(archivePath)).isFile(), 'Archive must be a regular file.');
  const root = await mkdtemp(path.join(outputParent, '.archive-probe-'));
  const snapshot = path.join(root, 'archive.gz');
  const staging = path.join(root, 'staging');
  const destination = path.join(root, 'payload');
  let active;
  let consume;
  let extractor;
  try {
    await chmod(root, 0o700);
    await pipeline(
      createReadStream(archivePath),
      meter(payload.size, payload),
      createWriteStream(snapshot, { flags: 'wx', mode: 0o600 }),
      { signal },
    );
    const handle = await open(snapshot, 'r');
    const header = Buffer.alloc(10);
    const trailer = Buffer.alloc(8);
    try {
      await handle.read(header, 0, 10, 0);
      await handle.read(trailer, 0, 8, payload.size - 8);
    } finally {
      await handle.close();
    }
    assert(header.subarray(0, 8).equals(Buffer.from([31, 139, 8, 0, 0, 0, 0, 0])), 'Unsupported gzip header.');
    assert(header[8] === 0 || header[8] === 2 || header[8] === 4, 'Unsupported gzip flags.');
    await mkdir(staging, { mode: 0o700 });
    const inflate = createInflateRaw();
    const gate = new UstarGate(entries);
    extractor = tar.extract();
    const iterator = extractor[Symbol.asyncIterator](); // install error listener before the pipeline starts
    consume = (async () => {
      let index = 0;
      for await (const stream of { [Symbol.asyncIterator]: () => iterator }) {
        signal?.throwIfAborted();
        const entry = entries[index++];
        assert(
          entry && stream.header.name === entry.path && stream.header.type === entry.type,
          'Parser/header disagreement.',
        );
        assert.equal(stream.header.size, entry.type === 'file' ? entry.size : 0, 'Parser size disagreement.');
        const target = path.join(staging, entry.path);
        if (entry.type === 'directory') {
          await mkdir(target, { mode: 0o700 }); // parents must already be inventory entries
          await pipeline(
            stream,
            new Writable({
              write(chunk, encoding, callback) {
                callback(chunk.length ? new Error('Directory body.') : null);
              },
            }),
            { signal },
          );
        } else {
          await pipeline(
            stream,
            meter(entry.size, { size: entry.size, sha256: entry.sha256 }),
            createWriteStream(target, { flags: 'wx', mode: 0o600 }),
            { signal },
          );
          await chmod(target, entry.executable ? 0o755 : 0o644);
        }
      }
      assert.equal(index, entries.length, 'Missing tar entries.');
    })();
    consume.catch((error) => extractor.destroy(error));
    active = pipeline(createReadStream(snapshot, { start: 10, end: payload.size - 9 }), inflate, gate, extractor, {
      signal,
    });
    active.catch(noOp);
    await Promise.all([active, consume]);
    assert.equal(inflate.bytesWritten, payload.size - 18, 'Trailing compressed data or concatenated member.');
    assert.equal(gate.crc, trailer.readUInt32LE(0), 'Gzip CRC mismatch.');
    assert.equal(gate.bytes % 2 ** 32, trailer.readUInt32LE(4), 'Gzip ISIZE mismatch.');
    signal?.throwIfAborted();
    await rename(staging, destination); // inside our unique container, not a shared cache namespace
    signal?.throwIfAborted();
    return {
      root,
      directory: destination,
      tarBytes: gate.bytes,
      fileCount: entries.filter((entry) => entry.type === 'file').length,
    };
  } catch (error) {
    extractor?.destroy(error);
    await Promise.allSettled([active, consume].filter(Boolean));
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
