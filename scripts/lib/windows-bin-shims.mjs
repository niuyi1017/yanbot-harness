import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function normalizeWindowsBinShims(root) {
  const bins = path.join(root, 'node_modules/.bin');
  const expected = ['uuidv7', 'which'].flatMap((name) => [name, name + '.cmd', name + '.ps1']).sort();
  const actual = await readdir(bins, { withFileTypes: true });
  assert(
    actual.every((item) => item.isFile()),
    'Windows bin shim must be a regular file.',
  );
  assert.deepEqual(actual.map((item) => item.name).sort(), expected, 'Unreviewed Windows bin shim.');
  const result = [];
  for (const [name, entry] of [
    ['uuidv7', 'cli.js'],
    ['which', 'bin/which'],
  ]) {
    const pkg = JSON.parse(await readFile(path.join(root, 'node_modules', name, 'package.json'), 'utf8'));
    assert.equal(typeof pkg.bin === 'string' ? pkg.bin : pkg.bin[name], entry);
    assert.match(
      (await readFile(path.join(root, 'node_modules', name, entry), 'utf8')).split('\n')[0],
      /^#!\/usr\/bin\/env node\r?$/u,
    );
    const target = '../' + name + '/' + entry;
    const shell =
      '#!/bin/sh\nset -eu\nexec "${NODE_BINARY:-node}" "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/' +
      target +
      '" "$@"\n';
    const cmd = '@echo off\r\nnode "%~dp0' + target.replaceAll('/', '\\') + '" %*\r\n';
    const ps1 = '& node "$PSScriptRoot/' + target + '" @args\nexit $LASTEXITCODE\n';
    for (const [extension, content] of [
      ['', shell],
      ['.cmd', cmd],
      ['.ps1', ps1],
    ]) {
      await writeFile(path.join(bins, name + extension), content);
      result.push({ path: 'node_modules/.bin/' + name + extension, target });
    }
  }
  return result;
}
