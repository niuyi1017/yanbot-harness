import { describe, expect, it } from 'vitest';

import { assertProductionMongo, productionProxyCidrs } from '../src/production.js';
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
  it('blocks experimental CLI in production', () => {
    expect(parseCloudConfig({ ...base, CLOUD_EXPERIMENTAL_CLAUDE_CLI: 'true' }).experimentalClaudeCli).toBe(true);
    expect(() =>
      parseCloudConfig({
        ...base,
        NODE_ENV: 'production',
        CLOUD_TLS_TERMINATED: 'true',
        CLOUD_TRUST_PROXY: 'true',
        CLOUD_EXPERIMENTAL_CLAUDE_CLI: 'true',
      }),
    ).toThrow('Experimental');
  });

  it('parses safe defaults and a normalized Git allowlist', () => {
    const config = parseCloudConfig({
      ...base,
      PATH: '/usr/bin',
      CLOUD_GIT_ALLOWED_HOSTS: 'GitHub.com, gitlab.example.com',
    });
    expect(config.host).toBe('127.0.0.1');
    expect(config.gitAllowedHosts).toEqual(['github.com', 'gitlab.example.com']);
    expect(config.eventRetentionSeconds).toBe(604_800);
    expect(config.runAllowedRoles).toEqual(['owner', 'admin']);
    expect(config.allowedPermissionPolicies).toEqual(['interactive', 'read-only']);
    expect(config.maxActiveRunsPerOrganization).toBe(10);
    expect(config.maxRunsPerUtcDay).toBe(1_000);
    expect(() => parseCloudConfig({ ...base, CLOUD_RELARY_ENABLED: 'true' })).toThrow();
  });

  it('rejects empty, duplicate, unknown and unbounded admission settings', () => {
    expect(() => parseCloudConfig({ ...base, CLOUD_RUN_ALLOWED_ROLES: '' })).toThrow(/allowlist/u);
    expect(() => parseCloudConfig({ ...base, CLOUD_RUN_ALLOWED_ROLES: 'owner,owner' })).toThrow(/unique/u);
    expect(() => parseCloudConfig({ ...base, CLOUD_ALLOWED_PERMISSION_POLICIES: 'unrestricted' })).toThrow();
    expect(() => parseCloudConfig({ ...base, CLOUD_MAX_ACTIVE_RUNS_PER_ORGANIZATION: '10001' })).toThrow();
    expect(() => parseCloudConfig({ ...base, CLOUD_MAX_RUNS_PER_UTC_DAY: '1000001' })).toThrow();
  });

  it('requires the internal API and TLS Redis when the production relay is enabled', () => {
    expect(() => parseCloudConfig({ ...base, CLOUD_RELAY_ENABLED: 'true' })).toThrow(/internal API/u);
    expect(() =>
      parseCloudConfig({
        ...base,
        NODE_ENV: 'production',
        CLOUD_TLS_TERMINATED: 'true',
        CLOUD_TRUST_PROXY: 'true',
        CLOUD_INTERNAL_API_ENABLED: 'true',
        CLOUD_RELAY_ENABLED: 'true',
        CLOUD_REDIS_URL: 'redis://127.0.0.1:6379',
      }),
    ).toThrow(/TLS/u);
  });

  it('fails closed for missing secrets, filesystem root and production without trusted TLS', () => {
    expect(() => parseCloudConfig({ ...base, CLOUD_TOKEN_PEPPER: undefined })).toThrow();
    expect(() => parseCloudConfig({ ...base, CLOUD_WORKSPACE_ROOT: '/' })).toThrow(/filesystem root/u);
    expect(() => parseCloudConfig({ ...base, NODE_ENV: 'production' })).toThrow(/HTTPS/u);
  });

  it('enables production vendors only with the full isolated transport contract', () => {
    const production = {
      ...base,
      NODE_ENV: 'production',
      CLOUD_TLS_TERMINATED: 'true',
      CLOUD_TRUST_PROXY: 'true',
      MONGODB_URI: 'mongodb://harness:fixture@mongo.example.test:27017/harness?tls=true&replicaSet=rs0',
      CLOUD_ENABLED_VENDOR_ADAPTERS: 'com.anthropic.claude-code-cli,cn.tencent.codebuddy',
      CLOUD_VENDOR_SANDBOX_IMAGE: `sha256:${'a'.repeat(64)}`,
      CLOUD_INTERNAL_API_ENABLED: 'true',
      CLOUD_RELAY_ENABLED: 'true',
      CLOUD_REDIS_URL: 'rediss://harness:fixture@redis.example.test:6380',
      CLOUD_MODEL_BROKER_POLICIES_FILE: '/srv/harness/broker.json',
    };
    expect(parseCloudConfig(production)).toMatchObject({
      experimentalClaudeCli: true,
      experimentalCodeBuddy: true,
      productionSandboxImage: production.CLOUD_VENDOR_SANDBOX_IMAGE,
      trustedProxyCidrs: ['127.0.0.1/32', '::1/128'],
    });
    for (const extra of [
      { CLOUD_VENDOR_SANDBOX_IMAGE: undefined },
      { CLOUD_REDIS_URL: 'rediss://redis.example.test' },
      { CLOUD_MODEL_BROKER_POLICIES_FILE: undefined },
      { CLOUD_RELAY_ENABLED: 'false' },
      { CLOUD_HOST: '0.0.0.0' },
      { MONGODB_URI: base.MONGODB_URI },
    ])
      expect(() => parseCloudConfig({ ...production, ...extra })).toThrow();
    expect(
      parseCloudConfig({ ...production, CLOUD_HOST: '0.0.0.0', CLOUD_TRUST_PROXY_CIDRS: '10.0.0.0/24' })
        .trustedProxyCidrs,
    ).toEqual(['10.0.0.0/24']);
  });

  it('rejects insecure Mongo certificate switches, unauthenticated Redis and broad proxy trust', () => {
    for (const uri of [
      'mongodb://user:secret@host/db?tls=false&replicaSet=rs0',
      'mongodb://user:secret@host/db?tls=true',
      'mongodb+srv://user:secret@host/db?tlsAllowInvalidCertificates=true',
      'mongodb://host/db?tls=true&replicaSet=rs0',
    ])
      expect(() => assertProductionMongo(uri)).toThrow();
    expect(() => assertProductionMongo('mongodb+srv://user:secret@host/db')).not.toThrow();
    for (const cidr of ['0.0.0.0/0', '::/0', '127.0.0.1/33', 'example.com', ''])
      expect(() => productionProxyCidrs('0.0.0.0', cidr)).toThrow();
  });

  it('defines only prefixed collections and required unique/TTL indexes', () => {
    expect(Object.values(collectionNames).every((name) => name.startsWith('yanbot_harness_'))).toBe(true);
    expect(modelDefinitions).toHaveLength(15);
    const admissionIndexes = modelDefinitions.find(([name]) => name === 'AdmissionState')?.[1].indexes() ?? [];
    expect(admissionIndexes).toEqual(
      expect.arrayContaining([
        expect.arrayContaining([{ organizationId: 1 }, expect.objectContaining({ unique: true })]),
      ]),
    );
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
      MONGODB_URI: 'mongodb://harness:fixture@mongo.example.test:27017/harness?tls=true&replicaSet=rs0',
    });
    const middleware = new ProductionHttpsMiddleware(config);
    expect(() => middleware.use({ secure: false } as never, {} as never, () => undefined)).toThrow(/HTTPS/u);
  });
});
