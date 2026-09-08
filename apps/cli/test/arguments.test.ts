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
});
