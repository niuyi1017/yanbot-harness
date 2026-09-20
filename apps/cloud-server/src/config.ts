import path from 'node:path';

import { z } from 'zod';

const booleanText = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');
const positiveInteger = (fallback: number) => z.coerce.number().int().positive().default(fallback);

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    CLOUD_HOST: z.string().trim().min(1).default('127.0.0.1'),
    CLOUD_PORT: z.coerce.number().int().min(0).max(65_535).default(3_878),
    CLOUD_TRUST_PROXY: booleanText,
    CLOUD_TLS_TERMINATED: booleanText,
    MONGODB_URI: z.string().trim().min(1),
    CLOUD_MONGODB_DATABASE: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{1,64}$/u)
      .default('yanbot_harness'),
    CLOUD_TOKEN_PEPPER: z.string().min(32),
    CLOUD_WORKSPACE_ROOT: z.string().trim().min(1),
    CLOUD_ACCESS_TOKEN_TTL_SECONDS: positiveInteger(900),
    CLOUD_REFRESH_TOKEN_TTL_SECONDS: positiveInteger(604_800),
    CLOUD_EVENT_RETENTION_SECONDS: positiveInteger(604_800),
    CLOUD_WORKSPACE_TTL_SECONDS: positiveInteger(86_400),
    CLOUD_GIT_ALLOWED_HOSTS: z.string().default(''),
    CLOUD_INTERNAL_API_ENABLED: booleanText,
  })
  .strict();

export type CloudConfig = {
  nodeEnv: 'development' | 'test' | 'production';
  host: string;
  port: number;
  trustProxy: boolean;
  tlsTerminated: boolean;
  mongodbUri: string;
  mongodbDatabase: string;
  tokenPepper: string;
  workspaceRoot: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  eventRetentionSeconds: number;
  workspaceTtlSeconds: number;
  gitAllowedHosts: readonly string[];
  internalApiEnabled: boolean;
};

export function parseCloudConfig(environment: NodeJS.ProcessEnv): CloudConfig {
  const value = environmentSchema.parse(environment);
  if (value.NODE_ENV === 'production' && (!value.CLOUD_TLS_TERMINATED || !value.CLOUD_TRUST_PROXY)) {
    throw new Error('Production Cloud Server requires trusted HTTPS termination.');
  }
  const workspaceRoot = path.resolve(value.CLOUD_WORKSPACE_ROOT);
  if (workspaceRoot === path.parse(workspaceRoot).root)
    throw new Error('The Cloud workspace root cannot be a filesystem root.');
  const gitAllowedHosts = value.CLOUD_GIT_ALLOWED_HOSTS.split(',')
    .map((host) => host.trim().toLocaleLowerCase('en-US'))
    .filter(Boolean);
  if (new Set(gitAllowedHosts).size !== gitAllowedHosts.length) {
    throw new Error('Git allowlist hosts must be unique.');
  }
  return {
    nodeEnv: value.NODE_ENV,
    host: value.CLOUD_HOST,
    port: value.CLOUD_PORT,
    trustProxy: value.CLOUD_TRUST_PROXY,
    tlsTerminated: value.CLOUD_TLS_TERMINATED,
    mongodbUri: value.MONGODB_URI,
    mongodbDatabase: value.CLOUD_MONGODB_DATABASE,
    tokenPepper: value.CLOUD_TOKEN_PEPPER,
    workspaceRoot,
    accessTokenTtlSeconds: value.CLOUD_ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTtlSeconds: value.CLOUD_REFRESH_TOKEN_TTL_SECONDS,
    eventRetentionSeconds: value.CLOUD_EVENT_RETENTION_SECONDS,
    workspaceTtlSeconds: value.CLOUD_WORKSPACE_TTL_SECONDS,
    gitAllowedHosts,
    internalApiEnabled: value.CLOUD_INTERNAL_API_ENABLED,
  };
}
