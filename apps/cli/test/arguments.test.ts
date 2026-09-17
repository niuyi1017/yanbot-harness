import { describe, expect, it } from 'vitest';

import { CliUsageError, parseArguments } from '../src/arguments.js';

describe('CLI arguments', () => {
  it('parses run options without accepting token arguments', () => {
    expect(
      parseArguments(['run', 'hello', 'world', '--permission', 'read-only', '--config-scope', 'project'], '/work'),
    ).toMatchObject({
      name: 'run',
      prompt: 'hello world',
      workspace: '/work',
      permissionPolicy: 'read-only',
      configScopes: ['project'],
    });
    expect(() => parseArguments(['sessions', '--token', 'secret'])).toThrow(CliUsageError);
  });

  it('accepts one explicit connection mode', () => {
    expect(parseArguments(['adapters', '--managed-runtime', '/runtime'])).toMatchObject({
      name: 'adapters',
      managedRuntimePath: '/runtime',
    });
    expect(() =>
      parseArguments(['adapters', '--managed-runtime', '/runtime', '--descriptor', '/descriptor']),
    ).toThrowError(/mutually exclusive/u);
    expect(parseArguments(['sessions', '--remote', 'https://runtime.example.test'])).toMatchObject({
      remoteOrigin: 'https://runtime.example.test',
    });
    expect(parseArguments(['sessions', '--profile', 'staging', '--profile-file', '/profiles.json'])).toMatchObject({
      profileName: 'staging',
      profileFile: '/profiles.json',
    });
    expect(() => parseArguments(['sessions', '--profile-file', '/profiles.json'])).toThrowError(/requires --profile/u);
    expect(() =>
      parseArguments(['sessions', '--profile', 'staging', '--remote', 'https://runtime.example.test']),
    ).toThrowError(/mutually exclusive/u);
  });
});
