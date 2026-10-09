import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { forwardModel, SecretFilter, type ModelTransport } from '../src/model-broker/forward.js';
import {
  brokerPoliciesSchema,
  CLAUDE_ADAPTER_ID,
  readPrivateFile,
  validateModelRequest,
} from '../src/model-broker/policy.js';
import { parseCloudConfig } from '../src/config.js';

const key = 'synthetic-private-key-for-tests';
const grant = 'yhe_synthetic-grant-for-tests';
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
const policy = {
  organizationId: randomUUID(),
  adapterId: CLAUDE_ADAPTER_ID,
  models: ['model-test'],
  apiKeyFile: '/private/test',
  maxRequests: 2,
  maxOutputTokens: 100,
} as const;
const valid = { model: 'model-test', messages: [{ role: 'user', content: 'Hi' }], max_tokens: 10, stream: true };
async function collect(body: AsyncIterable<Uint8Array>) {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString();
}
function transport(response: Response): ModelTransport {
  return async () => response;
}

describe('Model broker policies and transport', () => {
  it('redacts every byte split, overlapping prefixes, repeated secrets and preserves UTF-8', () => {
    const source = Buffer.from(`中文${key} ${grant} ${key}🐟end`);
    const expected = '中文[REDACTED] [REDACTED] [REDACTED]🐟end';
    for (let size = 1; size <= source.length; size++) {
      const filter = new SecretFilter([key, grant, key.slice(0, 5)]);
      const chunks: Buffer[] = [];
      for (let index = 0; index < source.length; index += size)
        chunks.push(filter.push(source.subarray(index, index + size)));
      chunks.push(filter.push(Buffer.alloc(0), true));
      expect(Buffer.concat(chunks).toString()).toBe(expected);
    }
  });
  it('rejects URLs, credentials, tools, oversized text, wrong model and token budget', () => {
    const parsed = brokerPoliciesSchema.parse({ version: 1, policies: [policy] }).policies[0]!;
    expect(JSON.parse(validateModelRequest(valid, parsed))).toEqual(valid);
    for (const value of [
      { ...valid, url: 'http://169.254.169.254' },
      { ...valid, headers: { authorization: key } },
      { ...valid, tools: [] },
      { ...valid, model: 'forbidden' },
      { ...valid, max_tokens: 101 },
      { ...valid, messages: [{ role: 'user', content: 'x'.repeat(65_537) }] },
    ])
      expect(() => validateModelRequest(value, parsed)).toThrow();
    expect(() => validateModelRequest(valid, parsed, 'different-run-model')).toThrow();
    expect(() => brokerPoliciesSchema.parse({ version: 1, policies: [policy, policy] })).toThrow();
  });
  it('requires an explicit experimental deployment and never enables production', () => {
    const config = {
      NODE_ENV: 'test',
      MONGODB_URI: 'mongodb://unused',
      CLOUD_TOKEN_PEPPER: 'p'.repeat(32),
      CLOUD_WORKSPACE_ROOT: '/tmp/test',
    };
    expect(parseCloudConfig(config).modelBrokerPoliciesFile).toBeUndefined();
    expect(() => parseCloudConfig({ ...config, CLOUD_MODEL_BROKER_POLICIES_FILE: '/private/policies' })).toThrow();
    expect(
      parseCloudConfig({
        ...config,
        CLOUD_MODEL_BROKER_POLICIES_FILE: '/private/policies',
        CLOUD_INTERNAL_API_ENABLED: 'true',
        CLOUD_EXPERIMENTAL_CLAUDE_CLI: 'true',
      }).modelBrokerPoliciesFile,
    ).toBe('/private/policies');
    expect(() =>
      parseCloudConfig({
        ...config,
        NODE_ENV: 'production',
        CLOUD_TRUST_PROXY: 'true',
        CLOUD_TLS_TERMINATED: 'true',
        CLOUD_MODEL_BROKER_POLICIES_FILE: '/private/policies',
      }),
    ).toThrow();
  });
  it.skipIf(process.platform === 'win32')(
    'reads only owner-private bounded regular files without following final symlinks',
    async () => {
      const directory = await mkdtemp(path.join(tmpdir(), 'broker-private-'));
      directories.push(directory);
      const filename = path.join(directory, 'credential');
      await writeFile(filename, key, { mode: 0o600 });
      expect(await readPrivateFile(filename, 100)).toBe(key);
      await expect(readPrivateFile(filename, 5)).rejects.toMatchObject({ status: 503 });
      await chmod(filename, 0o644);
      await expect(readPrivateFile(filename, 100)).rejects.toMatchObject({ status: 503 });
      await chmod(filename, 0o600);
      const link = path.join(directory, 'link');
      await symlink(filename, link);
      await expect(readPrivateFile(link, 100)).rejects.toMatchObject({ status: 503 });
      await expect(readPrivateFile(directory, 100)).rejects.toMatchObject({ status: 503 });
    },
  );
  it('sends only the fixed destination and headers and redacts streamed response bytes', async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of Buffer.from(`data: ${key} ${grant}\n\n`)) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    });
    const result = await forwardModel({
      body: JSON.stringify(valid),
      apiKey: key,
      grant,
      signal: new AbortController().signal,
      authorize: async () => {},
      transport: async (url, options) => {
        expect(url).toBe('https://api.anthropic.com/v1/messages');
        expect(options?.redirect).toBe('error');
        expect(options?.headers).toEqual({
          'x-api-key': key,
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
        });
        return new Response(source, { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    expect(await collect(result.body)).toBe('data: [REDACTED] [REDACTED]\n\n');
  });
  it.each([302, 401, 500])('discards upstream diagnostics and redirects for status %s', async (status) => {
    await expect(
      forwardModel({
        body: '{}',
        apiKey: key,
        grant,
        signal: new AbortController().signal,
        authorize: async () => {},
        transport: transport(
          new Response(key, {
            status,
            headers: { 'content-type': 'application/json', location: 'http://127.0.0.1/private' },
          }),
        ),
      }),
    ).rejects.toMatchObject({ status: 502, message: 'The model upstream response was rejected.' });
  });
  it('rejects unknown response types and bounded response overflow', async () => {
    const options = { body: '{}', apiKey: key, grant, signal: new AbortController().signal, authorize: async () => {} };
    await expect(forwardModel({ ...options, transport: transport(new Response('html')) })).rejects.toMatchObject({
      status: 502,
    });
    const result = await forwardModel({
      ...options,
      maxResponseBytes: 5,
      transport: transport(new Response('too long', { headers: { 'content-type': 'application/json' } })),
    });
    await expect(collect(result.body)).rejects.toMatchObject({ status: 502 });
  });
  it('aborts the upstream request on its total deadline without exposing transport errors', async () => {
    const pending: ModelTransport = async (_url, options) =>
      new Promise((_resolve, reject) => {
        options!.signal!.addEventListener('abort', () => reject(new Error(key)), { once: true });
      });
    await expect(
      forwardModel({
        body: '{}',
        apiKey: key,
        grant,
        timeoutMs: 20,
        signal: new AbortController().signal,
        authorize: async () => {},
        transport: pending,
      }),
    ).rejects.toMatchObject({ status: 504, code: 'RUN_TIMEOUT' });
  });
});
