import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { AuthService } from '../src/auth/auth.service.js';
import { CloudError } from '../src/common/cloud-error.js';
import type { CloudConfig } from '../src/config.js';
import { MemoryControlPlaneStore } from '../src/persistence/memory.store.js';

const config: CloudConfig = {
  nodeEnv: 'test',
  host: '127.0.0.1',
  port: 0,
  trustProxy: false,
  tlsTerminated: false,
  mongodbUri: 'mongodb://unused',
  mongodbDatabase: 'test',
  tokenPepper: 'p'.repeat(32),
  workspaceRoot: '/tmp/unused-cloud-workspaces',
  accessTokenTtlSeconds: 900,
  refreshTokenTtlSeconds: 604_800,
  eventRetentionSeconds: 604_800,
  workspaceTtlSeconds: 86_400,
  gitAllowedHosts: [],
  internalApiEnabled: false,
};

describe('Cloud authentication', () => {
  it('provisions a device, exchanges opaque tokens and resolves a tenant principal', async () => {
    const { auth, store, identity } = await setup();
    const tokens = await auth.exchange({
      organizationId: identity.organizationId,
      deviceId: identity.deviceId,
      deviceSecret: identity.deviceSecret,
    });
    expect(tokens.accessToken).toMatch(/^yha_[A-Za-z0-9_-]{43}$/u);
    expect(tokens.refreshToken).toMatch(/^yhr_[0-9a-f-]+\.[A-Za-z0-9_-]{43}$/u);
    await expect(auth.authenticate(`Bearer ${tokens.accessToken}`)).resolves.toMatchObject({
      organizationId: identity.organizationId,
      userId: identity.userId,
      deviceId: identity.deviceId,
    });
    expect(JSON.stringify(store)).not.toContain(identity.deviceSecret);
    expect(JSON.stringify(store)).not.toContain(tokens.accessToken);
    expect(JSON.stringify(store)).not.toContain(tokens.refreshToken);
  });

  it('rotates refresh tokens once and revokes the family on replay', async () => {
    const { auth, identity } = await setup();
    const first = await auth.exchange({
      organizationId: identity.organizationId,
      deviceId: identity.deviceId,
      deviceSecret: identity.deviceSecret,
    });
    const second = await auth.refresh({ refreshToken: first.refreshToken });
    expect(second.refreshToken).not.toBe(first.refreshToken);
    await expect(auth.refresh({ refreshToken: first.refreshToken })).rejects.toMatchObject({
      status: 401,
      code: 'AUTHENTICATION_FAILED',
    });
    await expect(auth.authenticate(`Bearer ${second.accessToken}`)).rejects.toBeInstanceOf(CloudError);
  });

  it('uses the same failure for unknown device, bad secret and malformed bearer', async () => {
    const { auth, identity } = await setup();
    for (const operation of [
      () =>
        auth.exchange({
          organizationId: identity.organizationId,
          deviceId: randomUUID(),
          deviceSecret: identity.deviceSecret,
        }),
      () =>
        auth.exchange({
          organizationId: identity.organizationId,
          deviceId: identity.deviceId,
          deviceSecret: 'wrong-secret',
        }),
      () => auth.authenticate('Basic secret'),
    ]) {
      await expect(operation()).rejects.toMatchObject({ status: 401, code: 'AUTHENTICATION_FAILED' });
    }
  });

  it('revalidates identity status and token expiry for every request', async () => {
    const { auth, store, identity } = await setup();
    const tokens = await auth.exchange({
      organizationId: identity.organizationId,
      deviceId: identity.deviceId,
      deviceSecret: identity.deviceSecret,
    });
    const device = store.devices.get(
      `${identity.organizationId.length}:${identity.organizationId}${identity.deviceId}`,
    );
    expect(device).toBeDefined();
    device!.status = 'disabled';
    await expect(auth.authenticate(`Bearer ${tokens.accessToken}`)).rejects.toMatchObject({ status: 401 });
    device!.status = 'active';
    store.tokens[0]!.accessExpiresAt = new Date(0);
    await expect(auth.authenticate(`Bearer ${tokens.accessToken}`)).rejects.toMatchObject({ status: 401 });
  });
});

async function setup() {
  const store = new MemoryControlPlaneStore();
  const auth = new AuthService(store, config);
  const organizationId = randomUUID();
  const userId = randomUUID();
  const deviceId = randomUUID();
  const provisioned = await auth.provision({
    organizationId,
    organizationName: 'Test organization',
    userId,
    userDisplayName: 'Test user',
    deviceId,
    roles: ['owner'],
  });
  return { auth, store, identity: { organizationId, userId, deviceId, deviceSecret: provisioned.deviceSecret } };
}
