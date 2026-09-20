import { HarnessClient } from '@yanbot-harness/sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { createRemoteReferenceFixture, type RemoteReferenceFixture } from '../src/index.js';

const fixtures: RemoteReferenceFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

describe('Remote Reference fixture boundaries', () => {
  it('rejects expired access tokens during Remote negotiation', async () => {
    const fixture = await trackedFixture();
    const token = fixture.issueToken({
      tenantId: 'tenant-a',
      subjectId: 'user-a',
      expiresAt: new Date(Date.now() - 1_000),
    });

    await expect(connect(fixture, token)).rejects.toMatchObject({
      kind: 'authentication',
      status: 401,
      harnessError: { code: 'AUTHENTICATION_FAILED' },
    });
  });

  it('does not resolve another tenant snapshot and rejects local path sources', async () => {
    const fixture = await trackedFixture();
    const tenantASnapshot = fixture.prepareSnapshot({ tenantId: 'tenant-a' });
    const tenantBToken = fixture.issueToken({ tenantId: 'tenant-b', subjectId: 'user-b' });
    const client = await connect(fixture, tenantBToken);
    const firstSession = await client.createSession({ adapterId: 'cn.yanbot.reference' });

    await expect(
      client.createRun(firstSession.sessionId, {
        prompt: 'Cross-tenant snapshot',
        workspace: tenantASnapshot,
      }),
    ).rejects.toMatchObject({ status: 404, harnessError: { code: 'HARNESS_FAILED' } });

    const secondSession = await client.createSession({ adapterId: 'cn.yanbot.reference' });
    await expect(
      client.createRun(secondSession.sessionId, {
        prompt: 'Local source',
        workspace: { kind: 'local-path-grant', workspaceGrant: 'must-not-be-resolved' },
      }),
    ).rejects.toMatchObject({ status: 400, harnessError: { code: 'CAPABILITY_UNSUPPORTED' } });
  });
});

async function trackedFixture(): Promise<RemoteReferenceFixture> {
  const fixture = await createRemoteReferenceFixture();
  fixtures.push(fixture);
  return fixture;
}

function connect(fixture: RemoteReferenceFixture, accessToken: string) {
  return HarnessClient.connect({
    mode: 'remote',
    origin: fixture.origin,
    tokenProvider: async () => ({ accessToken }),
    fetch: fixture.fetch,
  });
}
