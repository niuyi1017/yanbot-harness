import { HarnessClient } from '@yanbot-harness/sdk';

const client = await HarnessClient.fromDaemon();
await client.health();
const adapter = (await client.listAdapters())[0];
if (!adapter) throw new Error('The Runtime has no available Adapter.');
const grant = await client.grantWorkspace({ path: process.cwd() });
const session = await client.createSession({ adapterId: adapter.manifest.adapterId, title: 'SDK basic example' });
const run = await client.createRun(session.sessionId, {
  prompt: process.argv.slice(2).join(' ') || 'Say hello from the Yanbot Harness SDK.',
  workspaceGrant: grant.grant,
  permissionPolicy: 'read-only',
  configScopes: [],
  extensions: [],
  resume: false,
});

for await (const event of run.events()) {
  console.log(JSON.stringify(event));
}
