#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { resolveInstalledRuntime } from './index.mjs';
import { launcherEnvironment } from './launcher-environment.mjs';

const args = process.argv.slice(2);
if (args.some((item) => !['--reference', '--help', '--version'].includes(item)))
  throw new Error('Unsupported Runtime argument.');
const runtime = await resolveInstalledRuntime();
const child = spawn(process.execPath, [runtime.entryPath, ...args], {
  stdio: 'inherit',
  windowsHide: true,
  env: launcherEnvironment(),
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', () => {
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
