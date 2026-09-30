import { createWindowsCliJobOwner, buildAllowedEnvironment } from '../../dist/index.js';
import { fileURLToPath, URL } from 'node:url';

const owner = createWindowsCliJobOwner(process.argv[2]);
const child = owner.spawn({
  executablePath: process.execPath,
  args: [fileURLToPath(new URL('./fake-vendor.mjs', import.meta.url)), 'detached-child', process.argv[3]],
  environment: buildAllowedEnvironment(process.env, ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']),
});
child.stdout.on('data', (chunk) => process.stdout.write(chunk));
child.stderr.resume();
