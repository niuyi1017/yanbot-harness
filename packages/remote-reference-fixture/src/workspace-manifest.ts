import type { HarnessErrorCode } from '@yanbot-harness/contracts';
import {
  WORKSPACE_SNAPSHOT_LIMITS,
  validateWorkspaceManifest,
  type WorkspaceManifest,
  type WorkspaceManifestEntry,
} from '@yanbot-harness/workspace-snapshot';

export const REMOTE_WORKSPACE_LIMITS = WORKSPACE_SNAPSHOT_LIMITS;
export type RemoteWorkspaceManifestEntry = WorkspaceManifestEntry;
export type RemoteWorkspaceManifest = WorkspaceManifest;

export class RemoteFixturePreparationError extends Error {
  readonly code: HarnessErrorCode = 'CONFIGURATION_INVALID';

  constructor(options?: ErrorOptions) {
    super('The workspace manifest is invalid.', options);
    this.name = 'RemoteFixturePreparationError';
  }
}

export function validateRemoteWorkspaceManifest(
  value: unknown = { schemaVersion: 1, entries: [] },
  expectedDigest?: string,
): { manifest: RemoteWorkspaceManifest; digest: `sha256:${string}` } {
  try {
    return validateWorkspaceManifest(value, expectedDigest);
  } catch (error) {
    throw new RemoteFixturePreparationError({ cause: error });
  }
}
