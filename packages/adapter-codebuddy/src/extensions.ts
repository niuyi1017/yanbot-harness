import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AdapterExtensionSnapshot, AdapterRunInput, AdapterRuntimeContext } from '@yanbot-harness/adapter-api';
import { HarnessAdapterError } from '@yanbot-harness/adapter-api';
import type { CodeBuddyQueryInput } from './sdk-facade.js';

export type CodeBuddyExtensionProjection = {
  mcpServers: NonNullable<CodeBuddyQueryInput['mcpServers']>;
  env: Record<string, string>;
  paths: readonly string[];
  dispose(): Promise<void>;
};

/** Only host-resolved snapshots enter this private seam; no public config can enable it. */
export async function prepareExtensions(
  input: AdapterRunInput,
  context: AdapterRuntimeContext,
  stateRoot: string | undefined,
): Promise<CodeBuddyExtensionProjection> {
  const snapshots = input.extensionSnapshots ?? [];
  const selected = input.extensions.filter(({ enabled }) => enabled);
  if (
    selected.length !== snapshots.length ||
    selected.some(
      (item) =>
        !snapshots.some(
          (snapshot) =>
            snapshot.extensionId === item.extensionId && (!item.version || item.version === snapshot.version),
        ),
    )
  )
    invalid();
  if (new Set(snapshots.map(({ extensionId }) => extensionId)).size !== snapshots.length || snapshots.length > 32)
    invalid();
  if (!stateRoot || !path.isAbsolute(stateRoot) || !/^[a-f0-9-]{36}$/i.test(input.sessionId)) invalid();
  const cwd = input.cwd ?? process.cwd();
  for (const name of ['.codebuddy', '.mcp.json', '.codebuddy.json', 'CODEBUDDY.md', 'CODEBUDDY.local.md']) {
    if (await exists(path.join(cwd, name)))
      invalid('The extension workspace must not contain ambient vendor configuration.');
  }
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const root = await realpath(stateRoot);
  const session = path.join(root, input.sessionId);
  await mkdir(session, { recursive: true, mode: 0o700 });
  if ((await lstat(session)).isSymbolicLink() || (await realpath(session)) !== session) invalid();
  for (const name of ['skills', 'connectors', 'plugins', 'hooks', 'agents', 'settings.json', 'settings.local.json']) {
    if (await exists(path.join(session, name)))
      invalid('The private vendor session contains unexpected extension configuration.');
  }
  const leasePath = path.join(session, '.extension-lease');
  let lease;
  try {
    lease = await open(leasePath, 'wx', 0o600);
  } catch {
    invalid('The private vendor session is already in use or requires recovery.');
  }
  let projection: string | undefined;
  const dispose = async () => {
    try {
      if (projection) await rm(projection, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } finally {
      await lease.close();
      await rm(leasePath, { force: true });
    }
  };
  try {
    projection = await mkdtemp(path.join(session, 'run-'));
    const skillsRoot = path.join(projection, 'skills');
    await mkdir(skillsRoot);
    const env: Record<string, string> = {
      CODEBUDDY_CONFIG_DIR: session,
      WORKBUDDY_CONFIG_DIR: session,
      CODEBUDDY_SESSION_SKILL_DIRS: skillsRoot,
      CODEBUDDY_BUILTIN_SKILLS_DIR: '',
      CODEBUDDY_CUSTOM_HEADERS: '',
      CODEBUDDY_DISABLE_AUTO_MEMORY: '1',
    };
    const mcpServers: NonNullable<CodeBuddyQueryInput['mcpServers']> = {};
    let totalBytes = 0;
    for (const snapshot of snapshots) {
      if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(snapshot.extensionId)) invalid();
      if (snapshot.kind === 'mcp') {
        const mapped = mapMcp(snapshot, context);
        mcpServers[snapshot.extensionId] = mapped.server;
        Object.assign(env, mapped.env);
      } else {
        if (snapshot.resource.files.length > 128) invalid();
        const directory = path.join(skillsRoot, snapshot.extensionId);
        const names = new Set<string>();
        if (!snapshot.resource.files.some((file) => file.path === 'SKILL.md')) invalid();
        for (const file of snapshot.resource.files) {
          const segments = file.path.split('/');
          if (
            segments.length > 9 ||
            segments.some(
              (segment) =>
                !segment ||
                segment === '.' ||
                segment === '..' ||
                /[<>:"\\|?*]/.test(segment) ||
                /[. ]$/.test(segment) ||
                /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment) ||
                [...segment].some((character) => character.charCodeAt(0) < 32),
            )
          )
            invalid();
          if (names.has(file.path.toLowerCase())) invalid();
          names.add(file.path.toLowerCase());
          const bytes = Buffer.byteLength(file.content);
          if (bytes !== file.bytes || bytes > 262144 || hash(file.content) !== file.digest) invalid();
          totalBytes += bytes;
          if (totalBytes > 2097152) invalid();
          const target = path.join(directory, ...segments);
          await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
          await writeFile(target, file.content, { flag: 'wx', mode: 0o400 });
        }
      }
    }
    let disposed = false;
    return {
      env,
      mcpServers,
      paths: [session, projection],
      async dispose() {
        if (disposed) return;
        disposed = true;
        await dispose();
      },
    };
  } catch {
    await dispose();
    invalid('The private extension projection could not be prepared.');
  }
}

export function mapMcp(snapshot: Extract<AdapterExtensionSnapshot, { kind: 'mcp' }>, context: AdapterRuntimeContext) {
  const resource = snapshot.resource;
  const command = path.win32.basename(path.posix.basename(resource.command)).toLowerCase();
  if (
    resource.transport !== 'stdio' ||
    !resource.command ||
    /\.(cmd|bat)$/i.test(command) ||
    /^(cmd|powershell|pwsh|sh|bash|zsh|fish)(\.exe)?$/.test(command)
  )
    invalid();
  if (
    resource.args.length > 128 ||
    [resource.command, ...resource.args].some(
      (value) => value.length > 4096 || /[\0\r\n]/.test(value) || value.includes('${'),
    )
  )
    invalid();
  const bindings: Record<string, string> = {};
  const env: Record<string, string> = {};
  for (const [name, reference] of Object.entries(resource.envCredentialRefs)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || !/^[a-zA-Z0-9._-]{1,128}$/.test(reference)) invalid();
    const value = context.credentials?.[reference];
    if (!value) invalid('An MCP credential binding is unresolved.');
    const generated = `HARNESS_MCP_${hash(`${snapshot.extensionId}:${name}:${reference}`).slice(0, 24).toUpperCase()}`;
    bindings[name] = '${' + generated + '}';
    env[generated] = value;
  }
  return {
    server: { type: 'stdio' as const, command: resource.command, args: [...resource.args], env: bindings },
    env,
  };
}
async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
function hash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}
function invalid(message = 'The private extension snapshot is invalid.'): never {
  throw new HarnessAdapterError({ code: 'CONFIGURATION_INVALID', message, retryable: false });
}
