import {
  HarnessClient,
  HARNESS_RELEASE_VERSION,
  HarnessSdkError,
  type HarnessErrorCode,
  type Session,
} from '@yanbot-harness/sdk';
import { isIP } from 'node:net';

import { CliUsageError, parseArguments, type CliCommand } from './arguments.js';
import { promptForInteraction } from './interactions.js';
import { EventRenderer, type CliIo, writeAdapters, writeJson, writeModels, writeRun, writeSessions } from './output.js';
import { loadCliProfile, type CliProfile } from './profiles.js';
import { serializeWorkspaceSnapshot } from './snapshot.js';

export const CLI_VERSION = HARNESS_RELEASE_VERSION;
export const CLI_EXIT = {
  success: 0,
  usage: 2,
  cancelled: 10,
  interaction: 11,
  authentication: 20,
  upstream: 30,
  runtime: 40,
} as const;

export async function runCli(
  argv: readonly string[],
  options: {
    io?: CliIo;
    environment?: Readonly<Record<string, string | undefined>>;
    cwd?: string;
    fetch?: typeof fetch;
  } = {},
): Promise<number> {
  const io = options.io ?? { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr };
  try {
    const command = parseArguments(argv, options.cwd);
    if (command.name === 'help') {
      io.stdout.write(helpText);
      return CLI_EXIT.success;
    }
    if (command.name === 'version') {
      io.stdout.write(`${CLI_VERSION}\n`);
      return CLI_EXIT.success;
    }
    const connection = await connect(command, options.environment, options.fetch);
    try {
      return await execute(command, connection.client, connection.executionMode, io);
    } finally {
      await connection.close();
    }
  } catch (error) {
    const mapped = mapCliError(error);
    io.stderr.write(`${mapped.message}\n`);
    return mapped.exitCode;
  }
}

async function connect(
  command: Exclude<CliCommand, { name: 'help' | 'version' }>,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  fetchImplementation?: typeof fetch,
): Promise<{ client: HarnessClient; executionMode: 'local' | 'remote'; close(): Promise<void> }> {
  if (command.runtimeOrigin) {
    assertLegacyLoopbackOrigin(command.runtimeOrigin);
    const accessToken = environment.YANBOT_HARNESS_ACCESS_TOKEN;
    if (!accessToken)
      throw new CliFailure(CLI_EXIT.authentication, 'YANBOT_HARNESS_ACCESS_TOKEN is required with --runtime.');
    const client = new HarnessClient({
      origin: command.runtimeOrigin,
      accessToken,
      ...(fetchImplementation === undefined ? {} : { fetch: fetchImplementation }),
    });
    await client.health();
    return { client, executionMode: 'local', close: async () => undefined };
  }
  const profile = command.profileName
    ? await loadCliProfile(command.profileName, {
        ...(command.profileFile === undefined ? {} : { profileFile: command.profileFile }),
        environment,
      })
    : explicitProfile(command);
  if (profile.mode === 'remote') {
    const client = await HarnessClient.connect({
      mode: 'remote',
      origin: profile.origin,
      tokenProvider: environmentTokenProvider(environment, profile.tokenEnvironment),
      ...(fetchImplementation === undefined ? {} : { fetch: fetchImplementation }),
    });
    return { client, executionMode: 'remote', close: async () => undefined };
  }
  if (profile.mode === 'local-managed') {
    const runtime = await HarnessClient.connect({
      mode: 'local-managed',
      options: {
        ...(profile.executablePath === undefined ? {} : { executablePath: profile.executablePath }),
        environment,
        ...(fetchImplementation === undefined ? {} : { fetch: fetchImplementation }),
      },
    });
    return { client: runtime.client, executionMode: 'local', close: () => runtime.close() };
  }
  const client = await HarnessClient.connect({
    mode: 'local-daemon',
    ...(profile.descriptorPath === undefined ? {} : { descriptorPath: profile.descriptorPath }),
    environment,
    ...(fetchImplementation === undefined ? {} : { fetch: fetchImplementation }),
  });
  return { client, executionMode: 'local', close: async () => undefined };
}

function explicitProfile(command: Exclude<CliCommand, { name: 'help' | 'version' }>): CliProfile {
  if (command.remoteOrigin) {
    return {
      mode: 'remote',
      origin: command.remoteOrigin,
      tokenEnvironment: 'YANBOT_HARNESS_ACCESS_TOKEN',
    };
  }
  if (command.managedRuntimePath) {
    return { mode: 'local-managed', executablePath: command.managedRuntimePath };
  }
  return {
    mode: 'local-daemon',
    ...(command.descriptorPath === undefined ? {} : { descriptorPath: command.descriptorPath }),
  };
}

function environmentTokenProvider(environment: Readonly<Record<string, string | undefined>>, variable: string) {
  return async () => {
    const accessToken = environment[variable];
    if (!accessToken) {
      throw new HarnessSdkError('authentication', `Remote Runtime credential ${variable} is not available.`);
    }
    return { accessToken };
  };
}

function assertLegacyLoopbackOrigin(origin: string): void {
  let url: URL;
  try {
    url = new URL(origin);
  } catch (error) {
    throw new CliUsageError('--runtime requires a valid loopback HTTP URL.', { cause: error });
  }
  const hostname = url.hostname.replace(/^\[|\]$/gu, '');
  const version = isIP(hostname);
  if (
    url.protocol !== 'http:' ||
    (hostname !== 'localhost' && hostname !== '::1' && !(version === 4 && hostname.startsWith('127.')))
  ) {
    throw new CliUsageError('--runtime is a legacy Local option and requires a loopback HTTP URL; use --remote.');
  }
}

async function execute(
  command: Exclude<CliCommand, { name: 'help' | 'version' }>,
  client: HarnessClient,
  executionMode: 'local' | 'remote',
  io: CliIo,
): Promise<number> {
  switch (command.name) {
    case 'adapters':
      writeAdapters(io, await client.listAdapters(), command.json);
      return CLI_EXIT.success;
    case 'models':
      writeModels(io, await client.listModels(command.adapterId), command.json);
      return CLI_EXIT.success;
    case 'sessions':
      writeSessions(io, await client.listSessions(), command.json);
      return CLI_EXIT.success;
    case 'run-status':
      writeRun(io, await client.getRun(command.runId), command.json);
      return CLI_EXIT.success;
    case 'cancel':
      writeRun(io, await client.cancelRun(command.runId, command.reason), command.json);
      return CLI_EXIT.success;
    case 'run':
      if (executionMode === 'remote') {
        if (!command.remoteWorkspace)
          throw new CliUsageError('Remote run requires --snapshot or --git-repository with --git-commit.');
        if (command.relativeCwd) throw new CliUsageError('--cwd is only available for Local workspace grants.');
      } else if (command.remoteWorkspace) {
        throw new CliUsageError('--snapshot and Git workspace options require a Remote target.');
      }
      return executeRun(command, client, executionMode, io);
  }
}

async function executeRun(
  command: Extract<CliCommand, { name: 'run' }>,
  client: HarnessClient,
  executionMode: 'local' | 'remote',
  io: CliIo,
): Promise<number> {
  let session: Session;
  if (command.sessionId) {
    session = await client.getSession(command.sessionId);
    if (command.adapterId && command.adapterId !== session.adapterId) {
      throw new CliUsageError('--adapter does not match the selected Session.');
    }
  } else {
    const adapterId = command.adapterId ?? (await client.listAdapters())[0]?.manifest.adapterId;
    if (!adapterId) throw new CliFailure(CLI_EXIT.runtime, 'The Runtime has no available Adapter.');
    session = await client.createSession({ adapterId });
  }
  const workspaceInput =
    executionMode === 'local'
      ? await client.grantWorkspace({ path: command.workspace }).then((grant) => ({
          workspaceGrant: grant.grant,
          ...(command.relativeCwd === undefined ? {} : { relativeCwd: command.relativeCwd }),
        }))
      : await prepareRemoteWorkspace(command, client).then((prepared) => ({ workspace: prepared.workspace }));
  const handle = await client.createRun(session.sessionId, {
    prompt: command.prompt,
    ...workspaceInput,
    permissionPolicy: command.permissionPolicy,
    configScopes: command.configScopes,
    extensions: [],
    resume: command.resume,
    ...(command.modelId === undefined ? {} : { model: { adapterId: session.adapterId, modelId: command.modelId } }),
  });
  if (command.json) writeJson(io, { type: 'cli.run-created', run: handle.run, reused: handle.reused });
  const renderer = new EventRenderer(io, { json: command.json, logLevel: command.logLevel });
  renderer.info(`run: ${handle.run.runId}`);
  for await (const event of handle.events()) {
    renderer.event(event);
    if (event.type === 'interaction.requested') {
      if (command.json) return CLI_EXIT.interaction;
      const response = await promptForInteraction(io, event);
      if (!response)
        throw new CliFailure(CLI_EXIT.interaction, 'The run requires interaction, but stdin is not a TTY.');
      await handle.respond(response);
    }
    if (event.type === 'run.completed') return CLI_EXIT.success;
    if (event.type === 'run.cancelled') return CLI_EXIT.cancelled;
    if (event.type === 'run.failed') {
      throw new CliFailure(exitForHarnessCode(event.payload.error.code), event.payload.error.message);
    }
  }
  throw new CliFailure(CLI_EXIT.runtime, 'The Runtime event stream ended without a terminal event.');
}

async function prepareRemoteWorkspace(command: Extract<CliCommand, { name: 'run' }>, client: HarnessClient) {
  const source = command.remoteWorkspace;
  if (!source) throw new CliUsageError('Remote workspace preparation is required.');
  if (source.kind === 'git') {
    return client.prepareGitWorkspace({ repository: source.repository, commit: source.commit });
  }
  return client.prepareWorkspaceSnapshot(await serializeWorkspaceSnapshot(source.path));
}

class CliFailure extends Error {
  readonly exitCode: number;
  constructor(exitCode: number, message: string) {
    super(message);
    this.name = 'CliFailure';
    this.exitCode = exitCode;
  }
}

function mapCliError(error: unknown): { exitCode: number; message: string } {
  if (error instanceof CliUsageError)
    return { exitCode: CLI_EXIT.usage, message: `${error.message}\nRun yanbot-harness --help for usage.` };
  if (error instanceof CliFailure) return error;
  if (error instanceof HarnessSdkError) {
    if (error.kind === 'authentication') return { exitCode: CLI_EXIT.authentication, message: error.message };
    if (error.harnessError) return { exitCode: exitForHarnessCode(error.harnessError.code), message: error.message };
    return { exitCode: CLI_EXIT.runtime, message: error.message };
  }
  return { exitCode: CLI_EXIT.runtime, message: 'Yanbot Harness CLI failed.' };
}

function exitForHarnessCode(code: HarnessErrorCode): number {
  if (code === 'AUTHENTICATION_FAILED') return CLI_EXIT.authentication;
  if (code === 'PERMISSION_DENIED' || code === 'INTERACTION_EXPIRED') return CLI_EXIT.interaction;
  if (code === 'RUN_CANCELLED' || code === 'RUN_TIMEOUT') return CLI_EXIT.cancelled;
  if (code === 'ADAPTER_UNAVAILABLE' || code === 'HARNESS_FAILED') return CLI_EXIT.upstream;
  return CLI_EXIT.runtime;
}

const helpText = `Yanbot Harness CLI ${CLI_VERSION}

Usage:
  yanbot-harness run <prompt> [--adapter ID] [--session ID] [--workspace PATH]
      [--snapshot PATH | --git-repository HTTPS_URL --git-commit SHA]
      [--cwd RELATIVE] [--model ID] [--permission interactive|auto-edit|read-only]
      [--config-scope user|organization|project|local]... [--resume] [--json]
  yanbot-harness adapters [--json]
  yanbot-harness models --adapter ID [--json]
  yanbot-harness sessions [--json]
  yanbot-harness run-status <run-id> [--json]
  yanbot-harness cancel <run-id> [--reason TEXT] [--json]

Connection:
  --remote HTTPS_URL  Use a Remote Runtime with YANBOT_HARNESS_ACCESS_TOKEN.
  --profile NAME      Load a versioned Local/Remote target profile.
  --profile-file PATH Use this profile file with --profile.
  --descriptor PATH  Use a protected local Runtime descriptor.
  --managed-runtime PATH
                      Start and own an installed Runtime for this command.
  --runtime URL       Legacy loopback /local endpoint with YANBOT_HARNESS_ACCESS_TOKEN.
  Otherwise YANBOT_HARNESS_RUNTIME_DESCRIPTOR or ~/.yanbot-harness/runtime.json is used.

Remote run requires an explicit --snapshot directory or immutable Git repository and commit.
The implicit cwd and --workspace Local path are never sent to a Remote Runtime.
Access tokens are never accepted as command-line arguments or stored in profile files.

Output:
  --json              Emit newline-delimited JSON for run events.
  --log-level LEVEL   silent, error, info (default), or debug.
`;
