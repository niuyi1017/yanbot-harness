import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { isIP } from 'node:net';
import path from 'node:path';

import type { HarnessAdapter } from '@yanbot-harness/adapter-api';
import type { ConfigLayer } from '@yanbot-harness/config-loader';
import type { DiscoveredExtension } from '@yanbot-harness/extension-kit';

import { LocalAdapterService, type AdapterContextProvider } from './adapters.js';
import { createLocalRuntimeApp } from './app.js';
import { LocalAuthManager } from './auth.js';
import { LocalEventHub } from './event-hub.js';
import { FileLocalStateStore } from './local-state-store.js';
import { RunSupervisor } from './run-supervisor.js';
import { WorkspaceGrantRegistry } from './workspace-grants.js';

const RUNTIME_DESCRIPTOR_SCHEMA_VERSION = 1;

type RuntimeDescriptor = {
  schemaVersion: number;
  instanceId: string;
  pid: number;
  origin: string;
  accessToken: string;
  expiresAt: string;
};

export type StartLocalRuntimeOptions = {
  stateRoot: string;
  adapters: readonly HarnessAdapter[];
  host?: string;
  port?: number;
  runtimeDescriptorPath?: string;
  accessToken?: string;
  accessTokenTtlMs?: number;
  allowedOrigins?: readonly string[];
  contextProvider?: AdapterContextProvider;
  configLayers?: readonly ConfigLayer[];
  extensions?: readonly DiscoveredExtension[];
  maxConcurrentRuns?: number;
  runTimeoutMs?: number;
  interactionTimeoutMs?: number;
  shutdownGraceMs?: number;
  redactionSecrets?: readonly string[];
  now?: () => Date;
  generateId?: () => string;
  generateSecret?: () => string;
};

export type LocalRuntimeHandle = {
  origin: string;
  accessToken: string;
  issueBrowserBinding(origin: string, ttlMs?: number): { token: string; origin: string; expiresAt: string };
  close(): Promise<void>;
};

export async function startLocalRuntime(options: StartLocalRuntimeOptions): Promise<LocalRuntimeHandle> {
  const host = options.host ?? '127.0.0.1';
  assertLoopbackAddress(host);
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('The local runtime port is invalid.');
  const now = options.now ?? (() => new Date());
  const nowMs = () => now().getTime();
  const generateId = options.generateId ?? randomUUID;
  const auth = new LocalAuthManager({
    ...(options.accessToken === undefined ? {} : { accessToken: options.accessToken }),
    ...(options.accessTokenTtlMs === undefined ? {} : { accessTokenTtlMs: options.accessTokenTtlMs }),
    ...(options.allowedOrigins === undefined ? {} : { allowedOrigins: options.allowedOrigins }),
    ...(options.generateSecret === undefined ? {} : { generateSecret: options.generateSecret }),
    now: nowMs,
    generateId,
  });
  const workspaceRoots: string[] = [];
  const workspaceGrants = new WorkspaceGrantRegistry({
    now: nowMs,
    generateId,
    ...(options.generateSecret === undefined ? {} : { generateSecret: options.generateSecret }),
    onGrant: (root) => {
      if (!workspaceRoots.includes(root)) workspaceRoots.push(root);
    },
  });
  const store = new FileLocalStateStore({
    stateRoot: options.stateRoot,
    now,
    generateId,
    secrets: [auth.getAccessToken(), ...(options.redactionSecrets ?? [])],
    workspaceRoots,
  });
  await store.initialize();
  const eventHub = new LocalEventHub(store);
  const supervisor = new RunSupervisor({
    store,
    eventHub,
    adapters: new LocalAdapterService({
      adapters: options.adapters,
      ...(options.contextProvider === undefined ? {} : { contextProvider: options.contextProvider }),
    }),
    workspaceGrants,
    ...(options.configLayers === undefined ? {} : { configLayers: options.configLayers }),
    ...(options.extensions === undefined ? {} : { extensions: options.extensions }),
    ...(options.maxConcurrentRuns === undefined ? {} : { maxConcurrentRuns: options.maxConcurrentRuns }),
    ...(options.runTimeoutMs === undefined ? {} : { runTimeoutMs: options.runTimeoutMs }),
    ...(options.interactionTimeoutMs === undefined ? {} : { interactionTimeoutMs: options.interactionTimeoutMs }),
    now,
    generateId,
  });
  const server = createServer(
    createLocalRuntimeApp({ auth, workspaceGrants, supervisor, startedAt: now(), generateRequestId: generateId }),
  );

  let descriptor: RuntimeDescriptor | undefined;
  try {
    await listen(server, host, port);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('The local runtime did not open a TCP listener.');
    const origin = `http://${formatHost(host)}:${address.port}`;
    descriptor = {
      schemaVersion: RUNTIME_DESCRIPTOR_SCHEMA_VERSION,
      instanceId: generateId(),
      pid: process.pid,
      origin,
      accessToken: auth.getAccessToken(),
      expiresAt: auth.getAccessTokenExpiresAt(),
    };
    if (options.runtimeDescriptorPath) await writeDescriptor(options.runtimeDescriptorPath, descriptor, generateId);

    let closePromise: Promise<void> | undefined;
    return {
      origin,
      accessToken: auth.getAccessToken(),
      issueBrowserBinding: (browserOrigin, ttlMs) => auth.issueBrowserBinding(browserOrigin, ttlMs),
      close: () => {
        closePromise ??= closeRuntime(
          server,
          supervisor,
          options.runtimeDescriptorPath,
          descriptor!.instanceId,
          options.shutdownGraceMs ?? 5_000,
        );
        return closePromise;
      },
    };
  } catch (error) {
    await closeHttpServer(server);
    if (options.runtimeDescriptorPath && descriptor) {
      await removeOwnedDescriptor(options.runtimeDescriptorPath, descriptor.instanceId);
    }
    throw error;
  }
}

async function closeRuntime(
  server: Server,
  supervisor: RunSupervisor,
  descriptorPath: string | undefined,
  instanceId: string,
  graceMs: number,
): Promise<void> {
  const serverClosed = closeHttpServer(server);
  try {
    await supervisor.shutdown('The local runtime is shutting down.', graceMs);
    server.closeIdleConnections();
    server.closeAllConnections();
    await serverClosed;
  } finally {
    if (descriptorPath) await removeOwnedDescriptor(descriptorPath, instanceId);
  }
}

async function listen(server: Server, host: string, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

async function closeHttpServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function writeDescriptor(file: string, descriptor: RuntimeDescriptor, generateId: () => string): Promise<void> {
  const resolved = path.resolve(file);
  await mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 });
  const temporary = `${resolved}.${generateId()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(descriptor, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await rename(temporary, resolved);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function removeOwnedDescriptor(file: string, instanceId: string): Promise<void> {
  try {
    const parsed = JSON.parse(await readFile(path.resolve(file), 'utf8')) as { instanceId?: unknown };
    if (parsed.instanceId === instanceId) await rm(path.resolve(file), { force: true });
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

function assertLoopbackAddress(host: string): void {
  const version = isIP(host);
  if (host !== '::1' && !(version === 4 && host.startsWith('127.'))) {
    throw new Error('The local runtime may only listen on a loopback IP address.');
  }
}

function formatHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
