import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { jobHostControl } from '../src/windows-job-host.js';

describe('native host control (protocol fixtures, not Windows containment proof)', () => {
  it('binds readiness to the owned host and requires empty-Job proof', async () => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        `
      console.log(JSON.stringify({protocolVersion:1,type:'started',hostPid:process.pid,runtimePid:123}));
      process.stdin.on('data',()=>{console.log(JSON.stringify({protocolVersion:1,type:'stopped',activeProcesses:0}));process.exit(0);});
    `,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const control = jobHostControl(child);
    expect(await control.started).toBe(123);
    await control.terminate(1000);
  });
  it('rejects mismatched host identity and closes its lease', async () => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        `
      console.log(JSON.stringify({protocolVersion:1,type:'started',hostPid:0,runtimePid:123}));
      process.stdin.resume();process.stdin.on('end',()=>process.exit(0));
    `,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const control = jobHostControl(child);
    await expect(control.started).rejects.toThrow('Invalid native');
    await expect(control.terminate(1000)).rejects.toThrow();
  });
  it('never treats a clean host exit without empty-Job proof as cleanup success', async () => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        `
      console.log(JSON.stringify({protocolVersion:1,type:'started',hostPid:process.pid,runtimePid:123}));
    `,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const control = jobHostControl(child);
    await control.started;
    await expect(control.terminate(1000)).rejects.toThrow('CLEANUP_FAILED');
  });
});
