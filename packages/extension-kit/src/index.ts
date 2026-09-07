import { readFile, realpath, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  capabilityIdSchema,
  jsonObjectSchema,
  semverSchema,
  type CapabilityId,
  type ExtensionSelection,
  type HarnessCapabilities,
} from '@yanbot-harness/contracts';
import { z } from 'zod';

const MAX_EXTENSION_FILE_BYTES = 262_144;
const extensionIdSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/)
  .max(256);

export const extensionDescriptorSchema = z
  .object({
    extensionId: extensionIdSchema,
    kind: z.enum(['mcp', 'skill', 'agent', 'hook']),
    version: semverSchema,
    displayName: z.string().trim().min(1).max(256),
    description: z.string().trim().max(1_024).optional(),
    source: z.enum(['bundled', 'user', 'project']),
    configSchema: jsonObjectSchema.optional(),
    requiredCapabilities: z.array(capabilityIdSchema).default([]),
    credentialRefs: z.array(z.string().trim().min(1).max(128)).default([]),
  })
  .strict();

export type ExtensionDescriptor = z.infer<typeof extensionDescriptorSchema>;
export type DiscoveredExtension = { descriptor: ExtensionDescriptor; resourcePath: string };

export class ExtensionKitError extends Error {
  readonly code: 'EXTENSION_INVALID' | 'EXTENSION_NOT_FOUND' | 'CAPABILITY_UNSUPPORTED' | 'EXTENSION_OUTSIDE_ROOT';

  constructor(code: ExtensionKitError['code'], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ExtensionKitError';
    this.code = code;
  }
}

export async function discoverSkills(
  roots: readonly { path: string; source: ExtensionDescriptor['source'] }[],
): Promise<DiscoveredExtension[]> {
  try {
    const discovered: DiscoveredExtension[] = [];
    for (const rootInput of roots) {
      const root = await canonicalDirectory(rootInput.path);
      const entries = await readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const resourcePath = await realpath(path.join(root, entry.name, 'SKILL.md')).catch(() => undefined);
        if (!resourcePath || !isWithin(root, resourcePath)) continue;
        const content = await readLimitedFile(resourcePath);
        const metadata = parseFrontmatter(content);
        const descriptor = extensionDescriptorSchema.parse({
          extensionId: metadata.name ?? entry.name,
          kind: 'skill',
          version: metadata.version ?? '0.0.0',
          displayName: metadata.name ?? entry.name,
          ...(metadata.description ? { description: metadata.description } : {}),
          source: rootInput.source,
          requiredCapabilities: ['extensions.skills'],
          credentialRefs: [],
        });
        discovered.push({ descriptor, resourcePath });
      }
    }
    return assertUnique(discovered);
  } catch (error) {
    throw asExtensionError(error, 'Skill discovery failed.');
  }
}

export async function discoverMcpServers(options: {
  file: string;
  allowedRoot: string;
  source: ExtensionDescriptor['source'];
}): Promise<DiscoveredExtension[]> {
  try {
    const root = await canonicalDirectory(options.allowedRoot);
    const resourcePath = await realpath(path.resolve(options.file));
    if (!isWithin(root, resourcePath)) {
      throw new ExtensionKitError('EXTENSION_OUTSIDE_ROOT', 'The MCP configuration is outside its allowed root.');
    }
    const parsed: unknown = JSON.parse(await readLimitedFile(resourcePath));
    if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) {
      throw new ExtensionKitError('EXTENSION_INVALID', 'Invalid MCP configuration.');
    }
    return assertUnique(
      Object.entries(parsed.mcpServers).map(([name, raw]) => {
        if (!isRecord(raw)) throw new ExtensionKitError('EXTENSION_INVALID', `Invalid MCP server ${name}.`);
        const credentialRefs = Object.keys(raw).filter((key) =>
          /(?:token|secret|password|api[-_]?key|headers)/i.test(key),
        );
        return {
          descriptor: extensionDescriptorSchema.parse({
            extensionId: `mcp.${normalizeId(name)}`,
            kind: 'mcp',
            version: '0.0.0',
            displayName: name,
            source: options.source,
            requiredCapabilities: ['extensions.mcp'],
            credentialRefs,
          }),
          resourcePath,
        };
      }),
    );
  } catch (error) {
    throw asExtensionError(error, 'MCP discovery failed.');
  }
}

export function resolveExtensions(
  selections: readonly ExtensionSelection[],
  discovered: readonly DiscoveredExtension[],
  capabilities: HarnessCapabilities,
): DiscoveredExtension[] {
  const byId = new Map(discovered.map((extension) => [extension.descriptor.extensionId, extension]));
  return selections.flatMap((selection) => {
    if (!selection.enabled) return [];
    const extension = byId.get(selection.extensionId);
    if (!extension)
      throw new ExtensionKitError('EXTENSION_NOT_FOUND', `Extension ${selection.extensionId} was not found.`);
    if (selection.version && selection.version !== extension.descriptor.version) {
      throw new ExtensionKitError(
        'EXTENSION_INVALID',
        `Extension ${selection.extensionId} does not match the selected version.`,
      );
    }
    for (const capability of extension.descriptor.requiredCapabilities) assertCapability(capability, capabilities);
    return [extension];
  });
}

function assertCapability(capability: CapabilityId, capabilities: HarnessCapabilities): void {
  const level = capabilities[capability]?.level;
  if (!level || level === 'unsupported') {
    throw new ExtensionKitError('CAPABILITY_UNSUPPORTED', `The selected adapter does not support ${capability}.`);
  }
}

async function canonicalDirectory(value: string): Promise<string> {
  try {
    const canonical = await realpath(path.resolve(value));
    if (!(await stat(canonical)).isDirectory()) throw new Error();
    return canonical;
  } catch (error) {
    throw new ExtensionKitError('EXTENSION_INVALID', 'The extension root is not an accessible directory.', {
      cause: error,
    });
  }
}

async function readLimitedFile(file: string): Promise<string> {
  const info = await stat(file);
  if (!info.isFile() || info.size > MAX_EXTENSION_FILE_BYTES) {
    throw new ExtensionKitError('EXTENSION_INVALID', 'The extension file is invalid or too large.');
  }
  return readFile(file, 'utf8');
}

function parseFrontmatter(content: string): Record<string, string> {
  if (!content.startsWith('---\n')) return {};
  const end = content.indexOf('\n---', 4);
  if (end < 0) return {};
  return Object.fromEntries(
    content
      .slice(4, end)
      .split('\n')
      .flatMap((line) => {
        const separator = line.indexOf(':');
        if (separator <= 0) return [];
        return [
          [
            line.slice(0, separator).trim(),
            line
              .slice(separator + 1)
              .trim()
              .replace(/^['"]|['"]$/g, ''),
          ],
        ];
      }),
  );
}

function normalizeId(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!normalized) throw new ExtensionKitError('EXTENSION_INVALID', 'The extension name cannot form a stable ID.');
  return normalized;
}

function assertUnique(values: DiscoveredExtension[]): DiscoveredExtension[] {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value.descriptor.extensionId)) {
      throw new ExtensionKitError('EXTENSION_INVALID', `Duplicate extension ID ${value.descriptor.extensionId}.`);
    }
    seen.add(value.descriptor.extensionId);
  }
  return values;
}

function asExtensionError(error: unknown, message: string): ExtensionKitError {
  if (error instanceof ExtensionKitError) return error;
  return new ExtensionKitError('EXTENSION_INVALID', message, { cause: error });
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
