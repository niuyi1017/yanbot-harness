import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { CloudError } from '../common/cloud-error.js';

export const CLAUDE_ADAPTER_ID = 'com.anthropic.claude-code-cli';
export const MAX_MODEL_REQUEST_BYTES = 256 * 1024;
const modelId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const privatePath = z.string().refine((value) => path.isAbsolute(value) && !value.includes('\0'));
export const brokerPoliciesSchema = z
  .object({
    version: z.literal(1),
    policies: z
      .array(
        z
          .object({
            organizationId: z.string().uuid(),
            adapterId: z.literal(CLAUDE_ADAPTER_ID),
            models: z.array(modelId).min(1).max(16),
            apiKeyFile: privatePath,
            maxRequests: z.number().int().min(1).max(8),
            maxOutputTokens: z.number().int().min(1).max(4096),
          })
          .strict(),
      )
      .min(1)
      .max(128),
  })
  .strict()
  .superRefine((value, context) => {
    const keys = value.policies.map((policy) => `${policy.organizationId}:${policy.adapterId}`);
    if (new Set(keys).size !== keys.length) context.addIssue({ code: 'custom', message: 'Duplicate broker policy.' });
  });
export type BrokerPolicy = z.infer<typeof brokerPoliciesSchema>['policies'][number];
const text = z.string().max(65_536);
const content = z.union([
  text,
  z
    .array(z.object({ type: z.literal('text'), text }).strict())
    .min(1)
    .max(32),
]);
const requestSchema = z
  .object({
    model: modelId,
    messages: z
      .array(z.object({ role: z.enum(['user', 'assistant']), content }).strict())
      .min(1)
      .max(128),
    system: content.optional(),
    max_tokens: z.number().int().positive(),
    stream: z.boolean().optional(),
    temperature: z.number().min(0).max(1).optional(),
  })
  .strict();

export function validateModelRequest(value: unknown, policy: BrokerPolicy, selectedModel?: string): string {
  const parsed = requestSchema.safeParse(value);
  if (
    !parsed.success ||
    !policy.models.includes(parsed.data.model) ||
    (selectedModel !== undefined && parsed.data.model !== selectedModel) ||
    parsed.data.max_tokens > policy.maxOutputTokens
  )
    throw new CloudError(422, 'CONFIGURATION_INVALID', 'The model request is outside the deployment policy.');
  const encoded = JSON.stringify(parsed.data);
  if (Buffer.byteLength(encoded) > MAX_MODEL_REQUEST_BYTES)
    throw new CloudError(413, 'CONFIGURATION_INVALID', 'The model request exceeds the service limits.');
  return encoded;
}

/** Paths are deployment-owned. Never accept them from an HTTP/SDK request. */
export async function readPrivateFile(filename: string, maximumBytes: number): Promise<string> {
  try {
    if (process.platform === 'win32' || !path.isAbsolute(filename)) throw new Error();
    const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await file.stat();
      if (
        !before.isFile() ||
        before.uid !== process.getuid!() ||
        (before.mode & 0o077) !== 0 ||
        before.size < 1 ||
        before.size > maximumBytes
      )
        throw new Error();
      const bytes = Buffer.alloc(maximumBytes + 1);
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      const after = await file.stat();
      if (
        length > maximumBytes ||
        length !== before.size ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        (after.mode & 0o077) !== 0
      )
        throw new Error();
      return bytes.subarray(0, length).toString('utf8');
    } finally {
      await file.close();
    }
  } catch {
    throw new CloudError(503, 'CONFIGURATION_INVALID', 'The private broker configuration is unavailable.');
  }
}

export async function readModelKey(filename: string): Promise<string> {
  const value = (await readPrivateFile(filename, 8192)).trim();
  if (!/^[!-~]{16,8192}$/u.test(value))
    throw new CloudError(503, 'CONFIGURATION_INVALID', 'The broker credential is invalid.');
  return value;
}
