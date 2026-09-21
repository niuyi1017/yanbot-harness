import { createHash } from 'node:crypto';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { AdapterExtensionSnapshot } from '@yanbot-harness/adapter-api';
import type { ExtensionSelection, HarnessCapabilities } from '@yanbot-harness/contracts';
import { ExtensionKitError, resolveExtensions, type DiscoveredExtension } from './index.js';

const MAX_FILES = 128;
const MAX_FILE_BYTES = 262_144;
const MAX_TOTAL_BYTES = 2_097_152;
const MAX_DEPTH = 8;
const mcpSchema = z
  .object({
    type: z.literal('stdio').optional(),
    command: z.string().min(1).max(4096),
    args: z.array(z.string().max(4096)).max(128).default([]),
    envCredentialRefs: z
      .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().regex(/^[a-zA-Z0-9._-]{1,128}$/))
      .default({}),
  })
  .strict();

/** Trusted local resources only; no subprocesses, temporary files or secret resolution occur here. */
export async function snapshotExtensions(
  selections: readonly ExtensionSelection[],
  discovered: readonly DiscoveredExtension[],
  capabilities: HarnessCapabilities,
): Promise<readonly AdapterExtensionSnapshot[]> {
  try {
    const resolved = resolveExtensions(selections, discovered, capabilities);
    if (resolved.length > 32) invalid();
    const snapshots: AdapterExtensionSnapshot[] = [];
    let totalBytes = 0;
    for (const extension of resolved) {
      const selection = selections.find((item) => item.extensionId === extension.descriptor.extensionId)!;
      if (Object.keys(selection.config ?? {}).length) invalid();
      const root = await realpath(extension.allowedRoot ?? path.dirname(extension.resourcePath));
      const original = path.resolve(extension.resourcePath);
      const canonical = await realpath(original);
      if (!within(root, canonical) || (await lstat(original)).isSymbolicLink()) invalid();
      const main = await readStable(original, root);
      if (extension.resourceDigest && hash(main) !== extension.resourceDigest) invalid();
      const descriptor = extension.descriptor;
      const common = {
        extensionId: descriptor.extensionId,
        version: descriptor.version,
        source: descriptor.source,
        descriptorDigest: hash(stable(descriptor)),
      };
      let resource: AdapterExtensionSnapshot['resource'];
      if (descriptor.kind === 'skill') {
        const skillRoot = path.dirname(original);
        const files: { path: string; content: string; bytes: number; digest: string }[] = [];
        const names = new Set<string>();
        const walk = async (directory: string, relative: string, depth: number): Promise<void> => {
          if (depth > MAX_DEPTH) invalid();
          if ((await lstat(directory)).isSymbolicLink()) invalid();
          const entries = await readdir(directory, { withFileTypes: true });
          if (entries.length > MAX_FILES) invalid();
          for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            if (!portableName(entry.name) || entry.isSymbolicLink()) invalid();
            const file = path.join(directory, entry.name);
            const portable = relative ? `${relative}/${entry.name}` : entry.name;
            if (names.has(portable.toLowerCase())) invalid();
            names.add(portable.toLowerCase());
            if (names.size > MAX_FILES * 2) invalid();
            if (entry.isDirectory()) {
              await walk(file, portable, depth + 1);
              continue;
            }
            if (!entry.isFile() || files.length >= MAX_FILES) invalid();
            const content = await readStable(file, skillRoot);
            const bytes = Buffer.byteLength(content);
            totalBytes += bytes;
            if (totalBytes > MAX_TOTAL_BYTES) invalid();
            files.push({ path: portable, content, bytes, digest: hash(content) });
          }
        };
        await walk(skillRoot, '', 0);
        if (!files.some((file) => file.path === 'SKILL.md' && file.content === main)) invalid();
        resource = { files };
        snapshots.push({ ...common, kind: 'skill', resource, contentDigest: hash(stable({ ...common, resource })) });
      } else if (descriptor.kind === 'mcp') {
        const document = z
          .object({ mcpServers: z.record(z.string(), z.unknown()) })
          .strict()
          .parse(JSON.parse(main));
        const parsed = mcpSchema.parse(document.mcpServers[descriptor.displayName]);
        const commandName = path.win32.basename(path.posix.basename(parsed.command)).toLowerCase();
        if (
          /\.(cmd|bat)$/i.test(commandName) ||
          /^(?:cmd|powershell|pwsh|sh|bash|zsh|fish)(?:\.exe)?$/.test(commandName)
        )
          invalid();
        if ([parsed.command, ...parsed.args].some((value) => /[\0\r\n]/.test(value) || value.includes('${'))) invalid();
        if (
          parsed.args.some((value) =>
            /^(?:--?)?(?:api[-_]?key|token|secret|password|authorization)(?:=|$)/i.test(value),
          )
        )
          invalid();
        resource = {
          name: descriptor.extensionId,
          transport: 'stdio',
          command: parsed.command,
          args: parsed.args,
          envCredentialRefs: parsed.envCredentialRefs,
        };
        totalBytes += Buffer.byteLength(main);
        if (totalBytes > MAX_TOTAL_BYTES) invalid();
        snapshots.push({ ...common, kind: 'mcp', resource, contentDigest: hash(stable({ ...common, resource })) });
      } else invalid();
    }
    return freeze(snapshots);
  } catch (error) {
    if (error instanceof ExtensionKitError) throw error;
    throw new ExtensionKitError('EXTENSION_INVALID', 'Extension snapshot validation failed.');
  }
}

export function extensionSnapshotIdentity(
  snapshots: readonly AdapterExtensionSnapshot[],
  credentialRefs: Readonly<Record<string, string>> = {},
): string {
  return hash(
    stable({
      extensions: snapshots
        .map(({ extensionId, contentDigest }) => ({ extensionId, contentDigest }))
        .sort((a, b) => a.extensionId.localeCompare(b.extensionId)),
      credentialRefs,
    }),
  );
}

export async function readStable(file: string, root: string): Promise<string> {
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_FILE_BYTES) invalid();
  const canonical = await realpath(file);
  if (!within(root, canonical)) invalid();
  const handle = await open(file, 'r');
  try {
    const opened = await handle.stat();
    if (opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size) invalid();
    const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
    let used = 0;
    while (used < bytes.length) {
      const read = await handle.read(bytes, used, bytes.length - used, used);
      if (!read.bytesRead) break;
      used += read.bytesRead;
    }
    const after = await handle.stat();
    const final = await lstat(file);
    if (
      used > MAX_FILE_BYTES ||
      used !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      final.ino !== before.ino ||
      final.dev !== before.dev ||
      final.isSymbolicLink() ||
      (await realpath(file)) !== canonical
    )
      invalid();
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, used));
    if (content.includes('\0')) invalid();
    return content;
  } finally {
    await handle.close();
  }
}
function within(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
function portableName(name: string): boolean {
  return (
    !/[<>:"\\|?*]/.test(name) &&
    ![...name].some((character) => character.charCodeAt(0) < 32) &&
    !/[. ]$/.test(name) &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
  );
}
function invalid(): never {
  throw new ExtensionKitError('EXTENSION_INVALID', 'Extension snapshot validation failed.');
}
function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
