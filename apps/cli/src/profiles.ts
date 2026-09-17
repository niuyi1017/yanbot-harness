import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { CliUsageError } from './arguments.js';

export type CliProfile =
  | { mode: 'local-daemon'; descriptorPath?: string }
  | { mode: 'local-managed'; executablePath?: string }
  | { mode: 'remote'; origin: string; tokenEnvironment: string };

export async function loadCliProfile(
  name: string,
  options: {
    profileFile?: string;
    environment?: Readonly<Record<string, string | undefined>>;
  } = {},
): Promise<CliProfile> {
  const environment = options.environment ?? process.env;
  const profileFile = path.resolve(
    options.profileFile ??
      environment.YANBOT_HARNESS_PROFILE_FILE ??
      path.join(homedir(), '.yanbot-harness', 'profiles.json'),
  );
  let value: unknown;
  try {
    const raw = await readFile(profileFile, 'utf8');
    if (Buffer.byteLength(raw) > 65_536) throw new Error('Profile file exceeds 64 KiB.');
    value = JSON.parse(raw);
  } catch (error) {
    throw new CliUsageError(`Unable to read CLI profile file: ${profileFile}.`, { cause: error });
  }
  const profiles = parseProfileFile(value);
  if (!Object.hasOwn(profiles, name)) {
    throw new CliUsageError(`CLI profile "${name}" was not found in ${profileFile}.`);
  }
  return profiles[name]!;
}

function parseProfileFile(value: unknown): Record<string, CliProfile> {
  const record = object(value, 'CLI profile file');
  exactKeys(record, ['schemaVersion', 'profiles'], 'CLI profile file');
  if (record.schemaVersion !== 1) throw invalid('CLI profile file schemaVersion must be 1.');
  const rawProfiles = object(record.profiles, 'profiles');
  const profiles = Object.create(null) as Record<string, CliProfile>;
  for (const [name, profile] of Object.entries(rawProfiles)) {
    if (!name.trim()) throw invalid('CLI profile names cannot be empty.');
    profiles[name] = parseProfile(profile, name);
  }
  return profiles;
}

function parseProfile(value: unknown, name: string): CliProfile {
  const profile = object(value, `profile "${name}"`);
  if (profile.mode === 'local-daemon') {
    exactKeys(profile, ['mode', 'descriptorPath'], `profile "${name}"`);
    const descriptorPath = optionalString(profile.descriptorPath, 'descriptorPath');
    return {
      mode: 'local-daemon',
      ...(descriptorPath === undefined ? {} : { descriptorPath }),
    };
  }
  if (profile.mode === 'local-managed') {
    exactKeys(profile, ['mode', 'executablePath'], `profile "${name}"`);
    const executablePath = optionalString(profile.executablePath, 'executablePath');
    return {
      mode: 'local-managed',
      ...(executablePath === undefined ? {} : { executablePath }),
    };
  }
  if (profile.mode === 'remote') {
    exactKeys(profile, ['mode', 'origin', 'tokenEnvironment'], `profile "${name}"`);
    const tokenEnvironment =
      optionalString(profile.tokenEnvironment, 'tokenEnvironment') ?? 'YANBOT_HARNESS_ACCESS_TOKEN';
    if (!/^YANBOT_HARNESS_(?:[A-Z0-9]+_)*ACCESS_TOKEN$/u.test(tokenEnvironment)) {
      throw invalid(`profile "${name}" tokenEnvironment must name a YANBOT_HARNESS_*_ACCESS_TOKEN variable.`);
    }
    return { mode: 'remote', origin: requiredString(profile.origin, 'origin'), tokenEnvironment };
  }
  throw invalid(`profile "${name}" has an unsupported mode.`);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unexpected = Object.keys(record).find((key) => !allowed.includes(key));
  if (unexpected) throw invalid(`${label} contains unknown field "${unexpected}".`);
}

function requiredString(value: unknown, label: string): string {
  const result = optionalString(value, label);
  if (result === undefined) throw invalid(`${label} is required.`);
  return result;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw invalid(`${label} must be a non-empty string.`);
  return value;
}

function invalid(message: string): CliUsageError {
  return new CliUsageError(`Invalid CLI profile: ${message}`);
}
