import type { AdapterEvent, HarnessErrorCode, RunRequest } from '@yanbot-harness/contracts';
import { AdapterEventFactory } from '@yanbot-harness/adapter-kit';
import {
  CliHostError,
  createWindowsCliJobOwner,
  probeVendorVersion,
  runVendorCli,
  withCredentialDirectory,
} from '@yanbot-harness/adapter-cli-host';
import { ClaudeEventParser } from './parser.js';
import { CLAUDE_CODE_VERSION, manifest } from './manifest.js';

export type ClaudeDeployment = {
  executablePath: string;
  apiKey?: string;
  loopbackOrigin?: string;
  windowsJobHost?: string;
};

function environment(directory: string, deployment: ClaudeDeployment): Record<string, string> {
  return {
    HOME: directory,
    USERPROFILE: directory,
    CLAUDE_CONFIG_DIR: directory,
    PATH: process.platform === 'win32' ? `${process.env.SystemRoot}\\System32` : '/usr/bin:/bin',
    ...(process.platform === 'win32' && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    ...(deployment.apiKey ? { ANTHROPIC_API_KEY: deployment.apiKey } : {}),
    ...(deployment.loopbackOrigin
      ? {
          ANTHROPIC_BASE_URL: deployment.loopbackOrigin,
          CLAUDE_CODE_MAX_OUTPUT_TOKENS: '1024',
          MAX_THINKING_TOKENS: '0',
          CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: '1',
        }
      : {}),
  };
}
function owner(deployment: ClaudeDeployment) {
  return process.platform === 'win32' && deployment.windowsJobHost
    ? { processOwner: createWindowsCliJobOwner(deployment.windowsJobHost) }
    : {};
}
export async function probeClaude(deployment: ClaudeDeployment, signal?: AbortSignal): Promise<boolean> {
  return withCredentialDirectory({}, async (directory) => {
    const version = await probeVendorVersion(
      {
        executablePath: deployment.executablePath,
        args: ['--version'],
        workingDirectory: directory,
        environment: environment(directory, { executablePath: deployment.executablePath }),
      },
      { ...owner(deployment), runTimeoutMs: 15_000, ...(signal ? { signal } : {}) },
    );
    return version === `${CLAUDE_CODE_VERSION} (Claude Code)`;
  });
}

export async function executeClaudeRun(
  deployment: ClaudeDeployment,
  request: RunRequest,
  signal: AbortSignal,
  send: (event: AdapterEvent) => Promise<void>,
): Promise<void> {
  const factory = new AdapterEventFactory(request);
  const emit = async (type: AdapterEvent['type'], payload: unknown) => send(factory.create(type, payload));
  await emit('run.started', { adapterId: manifest.adapterId });
  let failureCode: HarnessErrorCode = 'HARNESS_FAILED';
  let parser: ClaudeEventParser | undefined;
  try {
    if (
      request.permissionPolicy !== 'read-only' ||
      request.extensions.length ||
      request.adapterSessionId ||
      request.configScopes.length
    ) {
      failureCode = 'CAPABILITY_UNSUPPORTED';
      throw new Error('Unsupported capability');
    }
    if (request.model && request.model.adapterId !== manifest.adapterId) {
      failureCode = 'CONFIGURATION_INVALID';
      throw new Error('Model adapter mismatch');
    }
    if (!(await probeClaude(deployment, signal))) {
      failureCode = 'ADAPTER_INCOMPATIBLE';
      throw new Error('Unsupported version');
    }
    parser = new ClaudeEventParser(emit);
    const activeParser = parser;
    await withCredentialDirectory(
      {},
      async (directory) => {
        const args = [
          '--bare',
          '-p',
          '--tools',
          '',
          '--permission-mode',
          'dontAsk',
          '--output-format',
          'stream-json',
          '--verbose',
          '--include-partial-messages',
          '--max-turns',
          String(request.maxTurns ?? 1),
          '--max-budget-usd',
          '0.10',
        ];
        if (request.model) args.push('--model', request.model.modelId);
        await runVendorCli({
          executablePath: deployment.executablePath,
          args,
          stdinText: request.prompt,
          workingDirectory: request.cwd ?? directory,
          environment: environment(directory, deployment),
          ...owner(deployment),
          signal,
          onStdoutLine: (line) => activeParser.line(line),
        });
      },
      { signal },
    );
    if (!parser.finished || !parser.initialized) {
      failureCode = 'HARNESS_PROTOCOL_ERROR';
      throw new Error('Missing result');
    }
    if (parser.vendorFailed) throw new Error('Vendor reported failure');
  } catch (error) {
    const cleanupFailed =
      error instanceof CliHostError && ['CLEANUP_UNVERIFIED', 'CREDENTIAL_CLEANUP_FAILED'].includes(error.code);
    if (cleanupFailed) failureCode = 'HARNESS_FAILED';
    else if (error instanceof CliHostError && error.code === 'CANCELLED') {
      await emit('run.cancelled', { reason: 'Run cancelled.' });
      return;
    } else if (error instanceof CliHostError && ['PARSER_ERROR', 'RESOURCE_LIMIT'].includes(error.code)) {
      failureCode = 'HARNESS_PROTOCOL_ERROR';
    } else if (parser?.authenticationFailed) failureCode = 'AUTHENTICATION_FAILED';
    else if (error instanceof CliHostError && ['RUN_TIMEOUT', 'IDLE_TIMEOUT', 'STARTUP_TIMEOUT'].includes(error.code))
      failureCode = 'RUN_TIMEOUT';
    else if (error instanceof CliHostError && error.code === 'SPAWN_ERROR') failureCode = 'ADAPTER_UNAVAILABLE';
    await emit('run.failed', { error: { code: failureCode, message: failureMessage(failureCode), retryable: false } });
    return;
  }
  if (parser.usage) await emit('usage.updated', parser.usage);
  await emit('run.completed', { usage: parser.usage });
}
function failureMessage(code: HarnessErrorCode): string {
  if (code === 'AUTHENTICATION_FAILED')
    return 'Claude Code authentication failed. Configure an authorized API key in the Runtime.';
  if (code === 'CAPABILITY_UNSUPPORTED')
    return 'This experimental adapter accepts text-only read-only runs without resume, extensions, or config scopes.';
  if (code === 'ADAPTER_INCOMPATIBLE') return 'The installed Claude Code version is not supported.';
  return 'Claude Code execution failed. Inspect the Runtime configuration and certified version.';
}
