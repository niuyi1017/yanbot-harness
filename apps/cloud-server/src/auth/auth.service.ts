import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { uuidSchema } from '@yanbot-harness/contracts';
import { z } from 'zod';

import { authenticationFailed, conflict } from '../common/cloud-error.js';
import type { CloudConfig } from '../config.js';
import type { TenantPrincipal, TokenGrantRecord } from '../domain.js';
import { CONTROL_PLANE_STORE, type ControlPlaneStore } from '../persistence/control-plane.store.js';
import { CLOUD_CONFIG } from '../persistence/mongo.service.js';

export const deviceExchangeSchema = z
  .object({ organizationId: uuidSchema, deviceId: uuidSchema, deviceSecret: z.string().min(1).max(256) })
  .strict();
export const refreshSchema = z.object({ refreshToken: z.string().min(1).max(512) }).strict();
export const provisionIdentitySchema = z
  .object({
    organizationId: uuidSchema,
    organizationName: z.string().trim().min(1).max(256),
    userId: uuidSchema,
    userDisplayName: z.string().trim().min(1).max(256),
    deviceId: uuidSchema,
    roles: z
      .array(z.enum(['owner', 'admin', 'member']))
      .min(1)
      .max(8),
  })
  .strict();

export type TokenPair = {
  accessToken: string;
  accessExpiresAt: string;
  refreshToken: string;
  refreshExpiresAt: string;
};

@Injectable()
export class AuthService {
  readonly #store: ControlPlaneStore;
  readonly #config: CloudConfig;
  readonly #now: () => Date;
  readonly #randomSecret: () => string;
  readonly #generateId: () => string;

  constructor(@Inject(CONTROL_PLANE_STORE) store: ControlPlaneStore, @Inject(CLOUD_CONFIG) config: CloudConfig) {
    this.#store = store;
    this.#config = config;
    this.#now = () => new Date();
    this.#randomSecret = () => randomBytes(32).toString('base64url');
    this.#generateId = randomUUID;
  }

  async provision(value: unknown): Promise<{ status: 'created'; deviceSecret: string }> {
    const input = provisionIdentitySchema.parse(value);
    const deviceSecret = `yhd_${this.#randomSecret()}`;
    const status = await this.#store.provisionIdentity({
      organization: { organizationId: input.organizationId, name: input.organizationName, status: 'active' },
      user: { userId: input.userId, displayName: input.userDisplayName, status: 'active' },
      membership: {
        organizationId: input.organizationId,
        userId: input.userId,
        roles: [...new Set(input.roles)],
        status: 'active',
      },
      device: {
        organizationId: input.organizationId,
        userId: input.userId,
        deviceId: input.deviceId,
        secretDigest: this.digest(deviceSecret),
        status: 'active',
        createdAt: this.#now(),
      },
    });
    if (status === 'existing') throw conflict('The device already exists.');
    return { status, deviceSecret };
  }

  async exchange(value: unknown): Promise<TokenPair> {
    const input = deviceExchangeSchema.parse(value);
    const device = await this.#store.findDevice(input.organizationId, input.deviceId);
    if (!device || !safeHexEqual(device.secretDigest, this.digest(input.deviceSecret))) throw authenticationFailed();
    const active = await this.#store.resolveActivePrincipal(device);
    if (!active) throw authenticationFailed();
    return this.#issue(device.organizationId, device.userId, device.deviceId, this.#generateId());
  }

  async refresh(value: unknown): Promise<TokenPair> {
    const input = refreshSchema.parse(value);
    const digest = this.digest(input.refreshToken);
    return this.#store.transaction(async () => {
      const previous = await this.#store.findRefreshGrant(digest);
      const now = this.#now();
      if (!previous || previous.revokedAt || previous.refreshExpiresAt <= now) throw authenticationFailed();
      if (previous.rotatedAt) {
        await this.#store.revokeTokenFamily(previous.familyId, now);
        throw authenticationFailed();
      }
      const active = await this.#store.resolveActivePrincipal(previous);
      if (!active || !(await this.#store.markRefreshRotated(digest, now))) throw authenticationFailed();
      return this.#issue(previous.organizationId, previous.userId, previous.deviceId, previous.familyId);
    });
  }

  async authenticate(authorization: string | undefined): Promise<TenantPrincipal> {
    const match = /^Bearer ([^\s]+)$/u.exec(authorization ?? '');
    if (!match?.[1]) throw authenticationFailed();
    const grant = await this.#store.findAccessGrant(this.digest(match[1]));
    const now = this.#now();
    if (!grant || grant.revokedAt || grant.accessExpiresAt <= now) throw authenticationFailed();
    const active = await this.#store.resolveActivePrincipal(grant);
    if (!active) throw authenticationFailed();
    return {
      organizationId: grant.organizationId,
      userId: grant.userId,
      deviceId: grant.deviceId,
      roles: active.membership.roles,
    };
  }

  digest(token: string): string {
    return createHash('sha256').update(this.#config.tokenPepper).update('\0').update(token).digest('hex');
  }

  async #issue(organizationId: string, userId: string, deviceId: string, familyId: string): Promise<TokenPair> {
    const now = this.#now();
    const accessToken = `yha_${this.#randomSecret()}`;
    const refreshToken = `yhr_${familyId}.${this.#randomSecret()}`;
    const record: TokenGrantRecord = {
      organizationId,
      userId,
      deviceId,
      familyId,
      accessDigest: this.digest(accessToken),
      refreshDigest: this.digest(refreshToken),
      accessExpiresAt: new Date(now.getTime() + this.#config.accessTokenTtlSeconds * 1_000),
      refreshExpiresAt: new Date(now.getTime() + this.#config.refreshTokenTtlSeconds * 1_000),
      createdAt: now,
    };
    await this.#store.insertTokenGrant(record);
    return {
      accessToken,
      accessExpiresAt: record.accessExpiresAt.toISOString(),
      refreshToken,
      refreshExpiresAt: record.refreshExpiresAt.toISOString(),
    };
  }
}

function safeHexEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'hex');
  const rightBytes = Buffer.from(right, 'hex');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
