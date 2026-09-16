#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
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
