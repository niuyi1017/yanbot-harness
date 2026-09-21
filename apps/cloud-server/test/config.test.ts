import { describe, expect, it } from 'vitest';

import { parseCloudConfig } from '../src/config.js';
import { ProductionHttpsMiddleware } from '../src/common/request-context.js';
import { collectionNames, modelDefinitions } from '../src/persistence/schemas.js';

const base = {
  NODE_ENV: 'test',
  MONGODB_URI: 'mongodb://127.0.0.1:27017',
  CLOUD_TOKEN_PEPPER: 'p'.repeat(32),
  CLOUD_WORKSPACE_ROOT: '/tmp/yanbot-cloud-workspaces',
};

describe('Cloud Server configuration', () => {
  it('parses safe defaults and a normalized Git allowlist', () => {
    const config = parseCloudConfig({ ...base, CLOUD_GIT_ALLOWED_HOSTS: 'GitHub.com, gitlab.example.com' });
    expect(config.host).toBe('127.0.0.1');
    expect(config.gitAllowedHosts).toEqual(['github.com', 'gitlab.example.com']);
    expect(config.eventRetentionSeconds).toBe(604_800);
  });

  it('fails closed for missing secrets, filesystem root and production without trusted TLS', () => {
    expect(() => parseCloudConfig({ ...base, CLOUD_TOKEN_PEPPER: undefined })).toThrow();
    expect(() => parseCloudConfig({ ...base, CLOUD_WORKSPACE_ROOT: '/' })).toThrow(/filesystem root/u);
    expect(() => parseCloudConfig({ ...base, NODE_ENV: 'production' })).toThrow(/HTTPS/u);
  });

  it('defines only prefixed collections and required unique/TTL indexes', () => {
    expect(Object.values(collectionNames).every((name) => name.startsWith('yanbot_harness_'))).toBe(true);
    expect(modelDefinitions).toHaveLength(14);
    const tokenIndexes = modelDefinitions.find(([name]) => name === 'TokenGrant')?.[1].indexes() ?? [];
    expect(tokenIndexes).toEqual(
      expect.arrayContaining([
        expect.arrayContaining([{ accessDigest: 1 }, expect.objectContaining({ unique: true })]),
        expect.arrayContaining([{ refreshExpiresAt: 1 }, expect.objectContaining({ expireAfterSeconds: 0 })]),
      ]),
    );
  });

  it('rejects a production request that the trusted proxy did not mark secure', () => {
    const config = parseCloudConfig({
      ...base,
      NODE_ENV: 'production',
      CLOUD_TLS_TERMINATED: 'true',
      CLOUD_TRUST_PROXY: 'true',
    });
    const middleware = new ProductionHttpsMiddleware(config);
    expect(() => middleware.use({ secure: false } as never, {} as never, () => undefined)).toThrow(/HTTPS/u);
  });
});
