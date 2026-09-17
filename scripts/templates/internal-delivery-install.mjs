#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const checksumFile = 'SHA256SUMS';

function safeRelative(relative) {
  assert(relative && !path.isAbsolute(relative) && !relative.includes('\\'));
  assert(
    relative.split('/').every((part) => part && part !== '.' && part !== '..' && !part.includes(':')),
    'Unsafe delivery path.',
  );
  return relative;
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function inventory(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = safeRelative(prefix ? prefix + '/' + entry.name : entry.name);
    const absolute = path.join(root, ...relative.split('/'));
    const info = await lstat(absolute);
    assert(!info.isSymbolicLink(), 'Delivery must not contain symbolic links.');
    if (info.isDirectory()) files.push(...(await inventory(absolute, relative)));
    else {
      assert(info.isFile(), 'Delivery entries must be regular files.');
      if (relative !== checksumFile) files.push({ path: relative, sha256: await sha256(absolute) });
    }
  }
  return files;
}

const expected = (await readFile(path.join(root, checksumFile), 'utf8'))
  .trimEnd()
  .split('\n')
  .map((line) => {
    const match = /^([a-f0-9]{64}) {2}(.+)$/u.exec(line);
    assert(match, 'Invalid SHA256SUMS line.');
    return { sha256: match[1], path: safeRelative(match[2]) };
  });
const actual = (await inventory(root)).sort((left, right) => left.path.localeCompare(right.path, 'en'));
assert.deepEqual(expected, actual, 'Delivery file set or digest changed.');

const args = process.argv.slice(2);
assert(
  args.length === 0 || (args.length === 2 && args[0] === '--prefix'),
  'Use node install.mjs [--prefix NEW_DIRECTORY].',
);
const prefix = path.resolve(args[1] ?? path.join(process.cwd(), 'yanbot-harness-local-consumer'));
const child = spawn(
  process.execPath,
  [
    path.join(root, 'offline-kit', 'install-local.mjs'),
    '--prefix',
    prefix,
    '--trusted-key-file',
    path.join(root, 'internal-test-trust.json'),
  ],
  { cwd: root, env: process.env, stdio: 'inherit', windowsHide: true },
);
child.once('error', (error) => {
  throw error;
});
child.once('exit', (code, signal) => {
  assert.equal(signal, null, `Installer terminated by ${signal}.`);
  process.exitCode = code ?? 1;
});
