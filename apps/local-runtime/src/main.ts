#!/usr/bin/env node
import { homedir } from 'node:os';
import path from 'node:path';

import { CodeBuddyAdapter } from '@yanbot-harness/adapter-codebuddy';
import { ReferenceAdapter, type ReferenceScenario } from '@yanbot-harness/adapter-reference';

import { createEnvironmentContextProvider } from './adapters.js';
import { startLocalRuntime } from './server.js';

const credentialEnvironmentKey = 'CODEBUDDY_API_KEY';
const RUNTIME_VERSION = '0.1.0-preview.1';

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  if (arguments_.includes('--version') || arguments_.includes('-v')) {
    process.stdout.write(`${RUNTIME_VERSION}\n`);
    return;
  }
  if (arguments_.includes('--help') || arguments_.includes('-h')) {
    process.stdout.write(helpText);
    return;
  }
  const unknownArguments = arguments_.filter((argument) => argument !== '--reference');
  if (unknownArguments.length > 0) throw new Error('Unsupported Runtime argument.');
  const stateRoot = process.env.YANBOT_HARNESS_STATE_DIR ?? path.join(homedir(), '.yanbot-harness');
  const adapterCredential = process.env[credentialEnvironmentKey];
  const adapterMode = process.argv.includes('--reference')
    ? 'reference'
    : (process.env.YANBOT_HARNESS_ADAPTER ?? 'codebuddy');
  if (adapterMode !== 'codebuddy' && adapterMode !== 'reference') throw new Error('Unsupported Runtime Adapter.');
  const usesCodeBuddy = adapterMode === 'codebuddy';
  const configuredReferenceScenario = referenceScenario();
  const adapterConfig = codeBuddyAdapterConfig();
  const runtime = await startLocalRuntime({
    stateRoot,
    runtimeDescriptorPath: path.join(stateRoot, 'runtime.json'),
    adapters: [
      usesCodeBuddy
        ? new CodeBuddyAdapter()
        : new ReferenceAdapter(
            configuredReferenceScenario === undefined ? {} : { scenario: configuredReferenceScenario },
          ),
    ],
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
              values: {
                adapter: adapterConfig,
                credentialRefs: { [credentialEnvironmentKey]: `env:${credentialEnvironmentKey}` },
              },
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

function codeBuddyAdapterConfig(): Record<string, string> {
  const internetEnvironment = process.env.CODEBUDDY_INTERNET_ENVIRONMENT;
  const baseUrl = process.env.CODEBUDDY_BASE_URL;
  const pathToCodebuddyCode = process.env.CODEBUDDY_CODE_PATH;
  return {
    ...(internetEnvironment ? { internetEnvironment } : {}),
    ...(baseUrl && internetEnvironment !== 'internal' ? { baseUrl } : {}),
    ...(pathToCodebuddyCode ? { pathToCodebuddyCode } : {}),
  };
}

function referenceScenario(): ReferenceScenario | undefined {
  const name = process.env.YANBOT_HARNESS_REFERENCE_SCENARIO;
  if (name === undefined || name === 'text') return undefined;
  if (name === 'permission') {
    return { kind: 'permission', toolName: 'ReferenceWrite', allowResult: 'Reference permission allowed.' };
  }
  if (name === 'question') {
    return { kind: 'question', prompt: 'Reference question?', answerResult: 'Reference question answered.' };
  }
  if (name === 'wait-for-cancel') return { kind: 'wait-for-cancel' };
  throw new Error('Unsupported Reference scenario.');
}

const helpText = `Yanbot Harness Local Runtime ${RUNTIME_VERSION}

Usage:
  yanbot-harness-runtime [--reference]
  yanbot-harness-runtime --help
  yanbot-harness-runtime --version

Options:
  --reference  Start with the credential-free Reference Adapter.

Environment:
  CODEBUDDY_API_KEY                  CodeBuddy credential (Runtime process only).
  CODEBUDDY_INTERNET_ENVIRONMENT     Use internal for the certified China route.
  YANBOT_HARNESS_ADAPTER             codebuddy (default) or reference.
  YANBOT_HARNESS_STATE_DIR           Runtime state and descriptor directory.
  YANBOT_HARNESS_ACCESS_TOKEN        Optional fixed Runtime bearer token.
  YANBOT_HARNESS_ALLOWED_ORIGINS     Optional comma-separated Origin allowlist.
  YANBOT_HARNESS_REFERENCE_SCENARIO  text, permission, question, or wait-for-cancel.
`;

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
