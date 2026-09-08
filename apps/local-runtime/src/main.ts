import { homedir } from 'node:os';
import path from 'node:path';

import { CodeBuddyAdapter } from '@yanbot-harness/adapter-codebuddy';
import { ReferenceAdapter } from '@yanbot-harness/adapter-reference';

import { createEnvironmentContextProvider } from './adapters.js';
import { startLocalRuntime } from './server.js';

const credentialEnvironmentKey = 'CODEBUDDY_API_KEY';

async function main(): Promise<void> {
  const stateRoot = process.env.YANBOT_HARNESS_STATE_DIR ?? path.join(homedir(), '.yanbot-harness');
  const adapterCredential = process.env[credentialEnvironmentKey];
  const adapterMode = process.argv.includes('--reference')
    ? 'reference'
    : (process.env.YANBOT_HARNESS_ADAPTER ?? 'codebuddy');
  if (adapterMode !== 'codebuddy' && adapterMode !== 'reference') throw new Error('Unsupported Runtime Adapter.');
  const usesCodeBuddy = adapterMode === 'codebuddy';
  const runtime = await startLocalRuntime({
    stateRoot,
    runtimeDescriptorPath: path.join(stateRoot, 'runtime.json'),
    adapters: [usesCodeBuddy ? new CodeBuddyAdapter() : new ReferenceAdapter()],
    ...(process.env.YANBOT_HARNESS_ACCESS_TOKEN === undefined
      ? {}
      : { accessToken: process.env.YANBOT_HARNESS_ACCESS_TOKEN }),
    allowedOrigins: parseOrigins(process.env.YANBOT_HARNESS_ALLOWED_ORIGINS),
    ...(usesCodeBuddy
      ? {
          configLayers: [
            {
              scope: 'enforced' as const,
              sourceRef: 'runtime:environment',
              values: { credentialRefs: { [credentialEnvironmentKey]: `env:${credentialEnvironmentKey}` } },
            },
          ],
          contextProvider: createEnvironmentContextProvider({ allowedEnvironmentKeys: [credentialEnvironmentKey] }),
          ...(adapterCredential ? { redactionSecrets: [adapterCredential] } : {}),
        }
      : {}),
  });
  process.stdout.write(`Yanbot Harness Local Runtime listening at ${runtime.origin}\n`);

  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    void runtime.close().catch(() => {
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

function parseOrigins(value: string | undefined): string[] {
  return value
    ? value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean)
    : [];
}

void main().catch(() => {
  process.stderr.write('Yanbot Harness Local Runtime failed to start.\n');
  process.exitCode = 1;
});
