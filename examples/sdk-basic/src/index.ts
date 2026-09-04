import { AdapterRegistry } from '@yanbot-harness/adapter-api';
import { ReferenceAdapter } from '@yanbot-harness/adapter-reference';
import { executeAdapterRun } from '@yanbot-harness/core';

const registry = new AdapterRegistry();
registry.register(new ReferenceAdapter({ scenario: { kind: 'text', chunks: ['Hello from Yanbot Harness.'] } }));

const adapter = registry.get('cn.yanbot.reference');
const request = {
  runId: '11111111-1111-4111-8111-111111111111',
  sessionId: '22222222-2222-4222-8222-222222222222',
  prompt: 'Say hello.',
  permissionPolicy: 'interactive' as const,
  configScopes: [],
  extensions: [],
};

for await (const event of executeAdapterRun(adapter, {}, request)) {
  console.log(JSON.stringify(event));
}
