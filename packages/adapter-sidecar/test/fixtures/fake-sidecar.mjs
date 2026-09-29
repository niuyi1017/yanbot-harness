import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { setTimeout } from 'node:timers';

const scenario = process.argv[2] ?? 'normal';
let input = '';
let output = Promise.resolve();
let heldProbe;

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  for (;;) {
    const newline = input.indexOf('\n');
    if (newline === -1) return;
    const line = input.slice(0, newline);
    input = input.slice(newline + 1);
    handle(JSON.parse(line));
  }
});

function handle(request) {
  if (scenario === 'stall') return;
  if (request.method === 'initialize') {
    if (scenario === 'invalid-json') {
      process.stdout.write('{invalid}\n');
      return;
    }
    if (scenario === 'stderr-flood') {
      process.stderr.write('secret-marker'.repeat(1024));
      return;
    }
    const result = {
      protocolVersion: scenario === 'wrong-version' ? '2.0.0' : '1.0.0',
      manifest: {
        protocolVersion: '1.0.0',
        adapterId: 'cn.yanbot.fake-sidecar',
        adapterVersion: '0.1.0',
        displayName: 'Fake Sidecar',
        harness: { name: 'Fake' },
        runtimeKinds: ['sidecar'],
      },
      capabilities: { 'runs.cancel': { level: 'native' } },
    };
    write({ jsonrpc: '2.0', id: scenario === 'wrong-id' ? 999 : request.id, result });
    if (scenario === 'normal') {
      write({ jsonrpc: '2.0', method: 'log', params: { level: 'info', message: 'secret-marker' } });
      write({
        jsonrpc: '2.0',
        method: 'event',
        params: {
          protocolVersion: '1.0.0',
          eventId: '11111111-1111-4111-8111-111111111111',
          runId: '22222222-2222-4222-8222-222222222222',
          sessionId: '33333333-3333-4333-8333-333333333333',
          sequence: 1,
          timestamp: '2026-09-29T00:00:00.000Z',
          type: 'run.started',
          payload: { adapterId: 'cn.yanbot.fake-sidecar' },
        },
      });
    }
    if (scenario === 'child-tree') {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore',
      });
      if (process.argv[3]) writeFileSync(process.argv[3], String(child.pid));
      process.stderr.write(`GRANDCHILD_PID=${child.pid}\n`);
    }
    return;
  }
  if (request.method === 'probe') {
    if (scenario === 'remote-error') {
      write({ jsonrpc: '2.0', id: request.id, error: { code: 500, message: 'secret-marker' } });
      return;
    }
    if (scenario === 'oversized-line') {
      process.stdout.write(`${'x'.repeat(2048)}\n`);
      return;
    }
    if (scenario === 'out-of-order') {
      if (!heldProbe) {
        heldProbe = request;
        return;
      }
      write({ jsonrpc: '2.0', id: request.id, result: { available: true, diagnostics: ['second'] } });
      write({ jsonrpc: '2.0', id: heldProbe.id, result: { available: true, diagnostics: ['first'] } });
      heldProbe = undefined;
      return;
    }
    output = output.then(async () => {
      const response = JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        result: { available: true, diagnostics: ['多字节 ✓'] },
      });
      const bytes = Buffer.from(`${response}\r\n`);
      const split = bytes.indexOf(Buffer.from('多')) + 1;
      process.stdout.write(bytes.subarray(0, split));
      await new Promise((resolve) => setTimeout(resolve, 5));
      process.stdout.write(bytes.subarray(split));
    });
    return;
  }
  if (request.method === 'shutdown') {
    write({ jsonrpc: '2.0', id: request.id, result: {} });
    if (scenario !== 'child-tree') setTimeout(() => process.exit(0), 5);
  }
}

function write(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
