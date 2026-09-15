import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
assert.equal(process.platform, 'win32', 'Native Windows host must be built on Windows with the MSVC environment.');
const output = path.resolve(process.argv[2] ?? 'native-build');
await mkdir(output, { recursive: true });
const source = path.resolve(import.meta.dirname, '../native/windows');
const artifacts = [];
for (const name of ['managed-job-host', 'breakaway-probe']) {
  const file = path.join(output, name + '.exe');
  await execute(
    'cl.exe',
    [
      '/nologo',
      '/std:c++17',
      '/W4',
      '/WX',
      '/EHsc',
      '/O2',
      '/MT',
      '/D_WIN32_WINNT=0x0A00',
      '/Fo' + path.join(output, name + '.obj'),
      '/Fe' + file,
      path.join(source, name + '.cpp'),
      '/link',
      '/INCREMENTAL:NO',
      '/DYNAMICBASE',
      '/NXCOMPAT',
    ],
    { cwd: output, timeout: 120000, maxBuffer: 1024 * 1024 },
  );
  const bytes = await readFile(file);
  artifacts.push({ file: name + '.exe', sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length });
}
const report = { schemaVersion: 1, target: 'win32-x64', productionSigned: false, artifacts };
await writeFile(path.join(output, 'native-build.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
