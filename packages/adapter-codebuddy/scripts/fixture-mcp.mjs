import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { setTimeout } from 'node:timers';

if (process.argv[2]) appendFileSync(process.argv[2], `${process.pid}\n`, { mode: 0o600 });
const input = createInterface({ input: process.stdin });
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
input.on('line', (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (request.id === undefined) return;
  if (request.method === 'initialize')
    send(request.id, {
      protocolVersion: request.params?.protocolVersion ?? '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'cee-fixture', version: '1.0.0' },
    });
  else if (request.method === 'ping') send(request.id, {});
  else if (request.method === 'tools/list')
    send(request.id, {
      tools: [
        {
          name: 'fixture_read',
          description: 'Harmless deterministic extension probe; returns CEE_MCP_OK and credential presence only.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
        {
          name: 'fixture_wait',
          description: 'Waits up to 30 seconds for a cancellation probe.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
      ],
    });
  else if (request.method === 'tools/call') {
    const result = {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ marker: 'CEE_MCP_OK', credentialsOk: Boolean(process.env.CEE_FIXTURE_KEY) }),
        },
      ],
    };
    if (request.params?.name === 'fixture_wait') setTimeout(() => send(request.id, result), 30000);
    else if (request.params?.name === 'fixture_read') send(request.id, result);
    else send(request.id, { content: [{ type: 'text', text: 'Unknown fixture tool.' }], isError: true });
  } else
    process.stdout.write(
      JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found.' } }) + '\n',
    );
});
input.on('close', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
