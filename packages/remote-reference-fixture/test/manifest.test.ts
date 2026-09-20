import { describe, expect, it } from 'vitest';

import {
  REMOTE_WORKSPACE_LIMITS,
  RemoteFixturePreparationError,
  validateRemoteWorkspaceManifest,
  type RemoteWorkspaceManifest,
} from '../src/index.js';

const emptyDigest = 'sha256:2807fc8bcb006a8ed65d5b7dfe0cd53a499342a2eac41195f0efdad44174b2bc';

describe('Remote workspace manifest validation', () => {
  it('canonicalizes valid empty and nested manifests with deterministic digests', () => {
    expect(validateRemoteWorkspaceManifest()).toEqual({
      manifest: { schemaVersion: 1, entries: [] },
      digest: emptyDigest,
    });
    const manifest: RemoteWorkspaceManifest = {
      schemaVersion: 1,
      entries: [
        { path: 'src', type: 'directory' },
        { path: 'src/index.ts', type: 'file', size: 3, sha256: 'a'.repeat(64), executable: false },
      ],
    };
    const result = validateRemoteWorkspaceManifest(manifest);
    expect(result.manifest).toEqual(manifest);
    expect(result.digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(validateRemoteWorkspaceManifest(manifest, result.digest)).toEqual(result);
  });

  it.each([
    ['traversal', { schemaVersion: 1, entries: [file('../secret')] }],
    ['absolute', { schemaVersion: 1, entries: [file('/private/secret')] }],
    ['drive', { schemaVersion: 1, entries: [file('C:\\secret')] }],
    ['backslash', { schemaVersion: 1, entries: [file('src\\secret')] }],
    ['reserved', { schemaVersion: 1, entries: [file('CON.txt')] }],
    ['trailing-dot', { schemaVersion: 1, entries: [file('secret.')] }],
    ['windows-invalid', { schemaVersion: 1, entries: [file('secret?.txt')] }],
    ['sensitive-git', { schemaVersion: 1, entries: [{ path: '.git', type: 'directory' }] }],
    ['sensitive-env', { schemaVersion: 1, entries: [file('.env.production')] }],
    ['sensitive-key', { schemaVersion: 1, entries: [file('private.pem')] }],
    ['case-collision', { schemaVersion: 1, entries: [file('README.md'), file('readme.md')] }],
    ['unicode-collision', { schemaVersion: 1, entries: [file('cafe\u0301.txt'), file('caf\u00e9.txt')] }],
    ['missing-parent', { schemaVersion: 1, entries: [file('src/index.ts')] }],
    ['non-directory-parent', { schemaVersion: 1, entries: [file('src'), file('src/index.ts')] }],
    ['unsorted', { schemaVersion: 1, entries: [file('z.txt'), file('a.txt')] }],
    ['unknown-type', { schemaVersion: 1, entries: [{ path: 'link', type: 'symlink', target: '../secret' }] }],
    ['unknown-field', { schemaVersion: 1, entries: [{ ...file('a.txt'), secret: true }] }],
    ['bad-digest', { schemaVersion: 1, entries: [{ ...file('a.txt'), sha256: 'bad' }] }],
    [
      'file-oversize',
      { schemaVersion: 1, entries: [{ ...file('a.txt'), size: REMOTE_WORKSPACE_LIMITS.fileBytes + 1 }] },
    ],
    [
      'total-oversize',
      {
        schemaVersion: 1,
        entries: Array.from({ length: 5 }, (_, index) => ({
          ...file(`file-${index}.bin`),
          size: REMOTE_WORKSPACE_LIMITS.fileBytes,
        })),
      },
    ],
    [
      'entry-oversize',
      {
        schemaVersion: 1,
        entries: Array.from({ length: REMOTE_WORKSPACE_LIMITS.entries + 1 }, (_, index) => file(`f-${index}.txt`)),
      },
    ],
  ])('rejects the %s manifest without reflecting attacker paths', (_name, manifest) => {
    let caught: unknown;
    try {
      validateRemoteWorkspaceManifest(manifest);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RemoteFixturePreparationError);
    expect(caught).toMatchObject({ code: 'CONFIGURATION_INVALID' });
    expect(String(caught)).toBe('RemoteFixturePreparationError: The workspace manifest is invalid.');
    expect(String(caught)).not.toContain('secret');
  });

  it('rejects an expected digest mismatch with the same stable error', () => {
    expect(() => validateRemoteWorkspaceManifest(undefined, `sha256:${'f'.repeat(64)}`)).toThrow(
      RemoteFixturePreparationError,
    );
  });
});

function file(relativePath: string) {
  return { path: relativePath, type: 'file' as const, size: 0, sha256: '0'.repeat(64), executable: false };
}
