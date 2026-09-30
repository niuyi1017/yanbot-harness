import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { writeFileSync } from 'node:fs';
import { setInterval, setTimeout } from 'node:timers';

const scenario = process.argv[2];

if (scenario === 'version') {
  process.stdout.write('fake-vendor 1.2.3\n');
} else if (scenario === 'normal') {
  const bytes = Buffer.from('α\r\nbeta\n');
  process.stdout.write(bytes.subarray(0, 1));
  setTimeout(() => process.stdout.write(bytes.subarray(1)), 5);
} else if (scenario === 'environment') {
  process.stdout.write(`${JSON.stringify(Object.keys(process.env).sort())}\n`);
} else if (scenario === 'long-line') {
  process.stdout.write(`${'x'.repeat(2_048)}\n`);
} else if (scenario === 'many-lines') {
  process.stdout.write('line\n'.repeat(512));
} else if (scenario === 'stdin-eof') {
  process.stdin.resume();
  process.stdin.on('end', () => process.stdout.write('eof\n'));
} else if (scenario === 'stderr-flood') {
  process.stderr.write(`secret-marker${'x'.repeat(2_048)}`);
} else if (scenario === 'invalid-utf8') {
  process.stdout.write(Buffer.from([0xff, 0x0a]));
} else if (scenario === 'noise') {
  process.stdout.write('secret-marker vendor noise\n');
} else if (scenario === 'exit4') {
  process.exitCode = 4;
} else if (scenario === 'stall' || scenario === 'ignore-term') {
  if (scenario === 'ignore-term') process.on('SIGTERM', () => undefined);
  process.stdout.write('started\n');
  setInterval(() => undefined, 1_000);
} else if (scenario === 'child') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], {
    stdio: 'ignore',
  });
  writeFileSync(process.argv[3], String(child.pid));
  process.stdout.write('started\n');
  setInterval(() => undefined, 1_000);
} else if (scenario === 'orphan') {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1000)'], { stdio: 'ignore' });
  child.unref();
  writeFileSync(process.argv[3], String(child.pid));
}
