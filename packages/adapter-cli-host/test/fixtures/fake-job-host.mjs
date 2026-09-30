import { writeSync } from 'node:fs';

const scenario = process.argv[2];
const frame = (value) => writeSync(3, JSON.stringify(value) + '\n');
frame({ protocolVersion: 1, type: 'started', hostPid: scenario === 'wrong-host' ? 1 : process.pid, childPid: 42 });
process.stdin.resume();
process.stdin.on('end', () => {
  const result = { protocolVersion: 1, type: 'stopped', activeProcesses: scenario === 'nonempty' ? 1 : 0, exitCode: 0 };
  if (scenario !== 'missing') frame(result);
  if (scenario === 'duplicate') frame(result);
  process.exitCode = scenario === 'wrong-exit' ? 4 : 0;
});
