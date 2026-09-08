import type { ConfigScope, PermissionPolicy } from '@yanbot-harness/sdk';

export type CliCommand =
  | { name: 'help' }
  | { name: 'version' }
  | ({ name: 'adapters' | 'sessions' } & CommonOptions)
  | ({ name: 'models'; adapterId: string } & CommonOptions)
  | ({ name: 'run-status'; runId: string } & CommonOptions)
  | ({ name: 'cancel'; runId: string; reason?: string } & CommonOptions)
  | ({
      name: 'run';
      prompt: string;
      adapterId?: string;
      sessionId?: string;
      workspace: string;
      relativeCwd?: string;
      modelId?: string;
      permissionPolicy: PermissionPolicy;
      configScopes: ConfigScope[];
      resume: boolean;
    } & CommonOptions);

type CommonOptions = {
  json: boolean;
  runtimeOrigin?: string;
  descriptorPath?: string;
  logLevel: 'silent' | 'error' | 'info' | 'debug';
};

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

export function parseArguments(argv: readonly string[], cwd = process.cwd()): CliCommand {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') return { name: 'help' };
  if (argv[0] === '--version' || argv[0] === '-v') return { name: 'version' };
  const name = argv[0];
  const parsed = parseOptions(argv.slice(1));
  const runtimeOrigin = option(parsed, 'runtime');
  const descriptorPath = option(parsed, 'descriptor');
  const common: CommonOptions = {
    json: flag(parsed, 'json'),
    logLevel: enumOption(parsed, 'log-level', ['silent', 'error', 'info', 'debug'], 'info'),
    ...(runtimeOrigin === undefined ? {} : { runtimeOrigin }),
    ...(descriptorPath === undefined ? {} : { descriptorPath }),
  };
  assertOnly(parsed, commonOptionNames(name));

  if (name === 'adapters' || name === 'sessions') {
    noPositionals(parsed, name);
    return { name, ...common };
  }
  if (name === 'models') {
    noPositionals(parsed, name);
    return { name, adapterId: requiredOption(parsed, 'adapter'), ...common };
  }
  if (name === 'run-status') {
    if (parsed.positionals.length !== 1) throw new CliUsageError(`${name} requires one run ID.`);
    return { name, runId: parsed.positionals[0]!, ...common };
  }
  if (name === 'cancel') {
    if (parsed.positionals.length !== 1) throw new CliUsageError(`${name} requires one run ID.`);
    const reason = option(parsed, 'reason');
    return { name, runId: parsed.positionals[0]!, ...(reason === undefined ? {} : { reason }), ...common };
  }
  if (name !== 'run') throw new CliUsageError(`Unknown command: ${name}`);
  if (parsed.positionals.length === 0) throw new CliUsageError('run requires a prompt.');
  const permissionPolicy = enumOption(parsed, 'permission', ['interactive', 'auto-edit', 'read-only'], 'interactive');
  const configScopes = options(parsed, 'config-scope').map((value) =>
    enumValue('config-scope', value, ['user', 'organization', 'project', 'local']),
  );
  const adapterId = option(parsed, 'adapter');
  const sessionId = option(parsed, 'session');
  const relativeCwd = option(parsed, 'cwd');
  const modelId = option(parsed, 'model');
  return {
    name: 'run',
    prompt: parsed.positionals.join(' '),
    workspace: option(parsed, 'workspace') ?? cwd,
    permissionPolicy,
    configScopes,
    resume: flag(parsed, 'resume'),
    ...(adapterId === undefined ? {} : { adapterId }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(relativeCwd === undefined ? {} : { relativeCwd }),
    ...(modelId === undefined ? {} : { modelId }),
    ...common,
  };
}

type ParsedOptions = { positionals: string[]; values: Map<string, string[]> };

function parseOptions(argv: readonly string[]): ParsedOptions {
  const parsed: ParsedOptions = { positionals: [], values: new Map() };
  const booleans = new Set(['json', 'resume']);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (!argument.startsWith('--')) {
      parsed.positionals.push(argument);
      continue;
    }
    const [rawName, inline] = argument.slice(2).split(/=(.*)/su, 2);
    if (!rawName) throw new CliUsageError('An option name is missing.');
    let value: string;
    if (booleans.has(rawName)) {
      if (inline !== undefined) throw new CliUsageError(`--${rawName} does not accept a value.`);
      value = 'true';
    } else {
      value = inline ?? argv[++index] ?? '';
      if (!value || value.startsWith('--')) throw new CliUsageError(`--${rawName} requires a value.`);
    }
    parsed.values.set(rawName, [...(parsed.values.get(rawName) ?? []), value]);
  }
  return parsed;
}

function commonOptionNames(command: string | undefined): Set<string> {
  const names = new Set(['json', 'runtime', 'descriptor', 'log-level']);
  const extras: Record<string, string[]> = {
    run: ['adapter', 'session', 'workspace', 'cwd', 'model', 'permission', 'config-scope', 'resume'],
    models: ['adapter'],
    cancel: ['reason'],
  };
  for (const name of extras[command ?? ''] ?? []) names.add(name);
  return names;
}

function assertOnly(parsed: ParsedOptions, allowed: Set<string>): void {
  for (const name of parsed.values.keys()) {
    if (!allowed.has(name)) throw new CliUsageError(`Unknown option: --${name}`);
  }
}

function noPositionals(parsed: ParsedOptions, command: string): void {
  if (parsed.positionals.length > 0) throw new CliUsageError(`${command} does not accept positional arguments.`);
}

function flag(parsed: ParsedOptions, name: string): boolean {
  return parsed.values.has(name);
}

function option(parsed: ParsedOptions, name: string): string | undefined {
  const values = parsed.values.get(name);
  if (values && values.length > 1 && name !== 'config-scope')
    throw new CliUsageError(`--${name} may only be used once.`);
  return values?.[0];
}

function options(parsed: ParsedOptions, name: string): string[] {
  return parsed.values.get(name) ?? [];
}

function requiredOption(parsed: ParsedOptions, name: string): string {
  const value = option(parsed, name);
  if (value === undefined) throw new CliUsageError(`--${name} is required.`);
  return value;
}

function enumOption<const T extends string>(
  parsed: ParsedOptions,
  name: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = option(parsed, name);
  return value === undefined ? fallback : enumValue(name, value, allowed);
}

function enumValue<const T extends string>(name: string, value: string, allowed: readonly T[]): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new CliUsageError(`--${name} must be one of: ${allowed.join(', ')}.`);
  }
  return value as T;
}
