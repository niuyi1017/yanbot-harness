import { setTimeout } from 'node:timers';

const scenario = process.argv[2] ?? 'text';
const manifest = {
  protocolVersion: '1.0.0',
  adapterId: 'cn.yanbot.sidecar-reference',
  adapterVersion: '0.1.0',
  displayName: scenario === 'wrong-manifest' ? 'Unexpected Fixture' : 'Sidecar Reference Fixture',
  harness: { name: 'Sidecar Reference Fixture' },
  runtimeKinds: ['sidecar'],
};
const capabilities = {
  'runs.cancel': { level: 'native' },
  'streaming.text': { level: 'native' },
};
let input = '';
let run;

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  for (;;) {
    const end = input.indexOf('\n');
    if (end === -1) return;
    const line = input.slice(0, end);
    input = input.slice(end + 1);
    handle(JSON.parse(line));
  }
});

function handle(request) {
  if (request.method === 'initialize') {
    respond(request.id, { protocolVersion: '1.0.0', manifest, capabilities });
    return;
  }
  if (request.method === 'probe') {
    respond(request.id, { available: true, harnessVersion: '0.1.0' });
    return;
  }
  if (request.method === 'startRun' || request.method === 'resumeRun') {
    run = { runId: request.params.runId, sessionId: request.params.sessionId, sequence: 0 };
    if (scenario === 'pre-ack') emit('run.started', { adapterId: manifest.adapterId });
    respond(request.id, {});
    if (scenario !== 'pre-ack') emit('run.started', { adapterId: manifest.adapterId });
    if (scenario === 'cancel') return;
    if (scenario === 'crash' || scenario === 'no-terminal') {
      setTimeout(() => process.exit(scenario === 'crash' ? 4 : 0), 10);
      return;
    }
    if (scenario === 'wrong-run') run.runId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    if (scenario === 'overflow') {
      for (let index = 0; index < 10; index += 1) emit('assistant.delta', { channel: 'output', text: 'x' });
    } else {
      emit('assistant.delta', { channel: 'output', text: 'Reference Sidecar response.' });
    }
    if (scenario === 'wrong-sequence') run.sequence += 1;
    emit('run.completed', {});
    if (scenario === 'duplicate-terminal') emit('run.completed', {});
    return;
  }
  if (request.method === 'cancel') {
    respond(request.id, {});
    if (run) emit('run.cancelled', { reason: 'Cancelled by test.' });
    return;
  }
  if (request.method === 'shutdown') {
    respond(request.id, {});
    setTimeout(() => process.exit(0), 5);
  }
}

function respond(id, result) {
  write({ jsonrpc: '2.0', id, result });
}

function emit(type, payload) {
  run.sequence += 1;
  write({
    jsonrpc: '2.0',
    method: 'event',
    params: {
      protocolVersion: '1.0.0',
      eventId: `00000000-0000-4000-8000-${String(run.sequence).padStart(12, '0')}`,
      runId: run.runId,
      sessionId: run.sessionId,
      sequence: run.sequence,
      timestamp: '2026-09-29T00:00:00.000Z',
      type,
      payload,
    },
  });
}

function write(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}
