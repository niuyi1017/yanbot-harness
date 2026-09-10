import {
  HarnessClient,
  HarnessSdkError,
  startManagedRuntime,
  type HarnessErrorCode,
  type LocalSession,
} from '@yanbot-harness/sdk';

import { CliUsageError, parseArguments, type CliCommand } from './arguments.js';
import { promptForInteraction } from './interactions.js';
import { EventRenderer, type CliIo, writeAdapters, writeJson, writeModels, writeRun, writeSessions } from './output.js';

export const CLI_VERSION = '0.1.0-preview.2';
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
      await connection.client.health();
      return await execute(command, connection.client, io);
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
): Promise<{ client: HarnessClient; close(): Promise<void> }> {
  if (command.runtimeOrigin) {
    const accessToken = environment.YANBOT_HARNESS_ACCESS_TOKEN;
    if (!accessToken)
      throw new CliFailure(CLI_EXIT.authentication, 'YANBOT_HARNESS_ACCESS_TOKEN is required with --runtime.');
    return {
      client: new HarnessClient({
        origin: command.runtimeOrigin,
        accessToken,
        ...(fetchImplementation === undefined ? {} : { fetch: fetchImplementation }),
      }),
      close: async () => undefined,
    };
  }
  if (command.managedRuntimePath) {
    const runtime = await startManagedRuntime({
      executablePath: command.managedRuntimePath,
      environment,
      ...(fetchImplementation === undefined ? {} : { fetch: fetchImplementation }),
    });
    return { client: runtime.client, close: () => runtime.close() };
  }
  return {
    client: await HarnessClient.fromDaemon({
      ...(command.descriptorPath === undefined ? {} : { descriptorPath: command.descriptorPath }),
      environment,
      ...(fetchImplementation === undefined ? {} : { fetch: fetchImplementation }),
    }),
    close: async () => undefined,
  };
}

async function execute(
  command: Exclude<CliCommand, { name: 'help' | 'version' }>,
  client: HarnessClient,
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
      return executeRun(command, client, io);
  }
}

async function executeRun(
  command: Extract<CliCommand, { name: 'run' }>,
  client: HarnessClient,
  io: CliIo,
): Promise<number> {
  let session: LocalSession;
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
  const grant = await client.grantWorkspace({ path: command.workspace });
  const handle = await client.createRun(session.sessionId, {
    prompt: command.prompt,
    workspaceGrant: grant.grant,
    permissionPolicy: command.permissionPolicy,
    configScopes: command.configScopes,
    extensions: [],
    resume: command.resume,
    ...(command.relativeCwd === undefined ? {} : { relativeCwd: command.relativeCwd }),
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
      [--cwd RELATIVE] [--model ID] [--permission interactive|auto-edit|read-only]
      [--config-scope user|organization|project|local]... [--resume] [--json]
  yanbot-harness adapters [--json]
  yanbot-harness models --adapter ID [--json]
  yanbot-harness sessions [--json]
  yanbot-harness run-status <run-id> [--json]
  yanbot-harness cancel <run-id> [--reason TEXT] [--json]

Connection:
  --runtime URL       Use URL with YANBOT_HARNESS_ACCESS_TOKEN.
  --descriptor PATH  Use a protected local Runtime descriptor.
  --managed-runtime PATH
                      Start and own an installed Runtime for this command.
  Otherwise YANBOT_HARNESS_RUNTIME_DESCRIPTOR or ~/.yanbot-harness/runtime.json is used.

Output:
  --json              Emit newline-delimited JSON for run events.
  --log-level LEVEL   silent, error, info (default), or debug.
`;
