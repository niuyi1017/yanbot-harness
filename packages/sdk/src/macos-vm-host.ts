import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, request, type IncomingMessage } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import {
  HARNESS_PROTOCOL_VERSION,
  HARNESS_RELEASE_VERSION,
  createWorkspaceGrantRequestSchema,
} from '@yanbot-harness/contracts';
import { HarnessClient } from './client.js';
import { protectManagedState } from './managed-permissions.js';
import type { ManagedRuntimeHandle, StartManagedRuntimeOptions } from './managed-runtime.js';
import { HarnessSdkError } from './transport.js';

export type VMContainment = {
  kind: 'macos-vm-v1';
  executablePath: string;
  kernel: { path: string; sha256: string };
  initrd: { path: string; sha256: string };
};
export type VMOptions = { workspaces?: readonly { path: string; readOnly: boolean }[]; network?: boolean };

export async function startVMRuntime(
  containment: VMContainment,
  options: StartManagedRuntimeOptions,
  signal: AbortSignal,
  shutdownTimeoutMs: number,
): Promise<ManagedRuntimeHandle> {
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || !path.isAbsolute(containment.executablePath))
    throw new HarnessSdkError('protocol', 'Unsupported VM containment host.');
  const environment = await vmEnvironment(options.environment ?? {}); // Never implicitly copy process.env into a VM.
  const shares = await workspaceShares(options.vm?.workspaces ?? []);
  signal.throwIfAborted();
  const root = options.stateRoot
    ? path.resolve(options.stateRoot)
    : await mkdtemp(path.join(tmpdir(), 'yanbot-harness-vm-'));
  const ownsRoot = options.stateRoot === undefined;
  let child: ChildProcess | undefined;
  let control: ReturnType<typeof vmControl> | undefined;
  let proxy: ReturnType<typeof createServer> | undefined;
  const descriptorPath = path.join(root, 'runtime.json');
  let instanceId: string | undefined;
  let configPath: string | undefined;
  const stopProxy = () => {
    proxy?.closeAllConnections();
    proxy?.close();
  };
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await protectManagedState(root, signal);
    if (await lstat(descriptorPath).catch(() => undefined))
      throw new HarnessSdkError('runtime', 'Managed descriptor already exists.');
    const guestState = path.join(root, 'guest-state');
    await mkdir(guestState, { recursive: true, mode: 0o700 });
    await protectManagedState(guestState, signal);
    shares.push({ name: 'state', path: await realpath(guestState), readOnly: false });
    configPath = path.join(root, 'vm-' + randomUUID() + '.json');
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        kernel: containment.kernel,
        initrd: containment.initrd,
        runtime: { shares, network: options.vm?.network === true },
      }),
      { flag: 'wx', mode: 0o600 },
    );
    signal.throwIfAborted();
    child = spawn(containment.executablePath, ['--probe-run', configPath], {
      env: {},
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    control = vmControl(child);
    child.once('exit', stopProxy);
    const socket = await abortable(control.ready, signal);
    const socketInfo = await lstat(socket);
    const parentInfo = await lstat(path.dirname(socket));
    if (
      !socketInfo.isSocket() ||
      socketInfo.uid !== process.getuid!() ||
      socketInfo.mode & 0o077 ||
      !parentInfo.isDirectory() ||
      parentInfo.uid !== process.getuid!() ||
      parentInfo.mode & 0o077
    )
      throw new HarnessSdkError('authentication', 'VM transport is not private.');
    const boot = await privateJson(
      socket,
      '/__harness/bootstrap',
      { environment, reference: options.reference === true },
      signal,
    );
    const descriptor = boot.descriptor;
    if (
      boot.runtimeVersion !== HARNESS_RELEASE_VERSION ||
      boot.protocolVersion !== HARNESS_PROTOCOL_VERSION ||
      !descriptor ||
      descriptor.schemaVersion !== 1 ||
      !Number.isSafeInteger(descriptor.pid) ||
      descriptor.pid <= 0 ||
      typeof descriptor.instanceId !== 'string' ||
      typeof descriptor.accessToken !== 'string' ||
      descriptor.accessToken.length < 16 ||
      descriptor.accessToken.length > 4096 ||
      typeof descriptor.origin !== 'string' ||
      !/^http:\/\/127\.0\.0\.1:\d+$/u.test(descriptor.origin) ||
      typeof descriptor.expiresAt !== 'string' ||
      !Number.isFinite(Date.parse(descriptor.expiresAt)) ||
      Date.parse(descriptor.expiresAt) <= Date.now()
    )
      throw new HarnessSdkError('protocol', 'Invalid VM Runtime readiness.');
    instanceId = descriptor.instanceId;
    const expectedAuthorization = createHash('sha256')
      .update('Bearer ' + descriptor.accessToken)
      .digest();
    proxy = createServer(async (incoming, outgoing) => {
      const deny = (status: number, message: string) => {
        outgoing.writeHead(status, { 'content-type': 'application/json' });
        outgoing.end(
          JSON.stringify({
            error: {
              code:
                status === 401
                  ? 'AUTHENTICATION_FAILED'
                  : status === 403
                    ? 'PERMISSION_DENIED'
                    : 'CONFIGURATION_INVALID',
              message,
              retryable: false,
            },
            requestId: randomUUID(),
          }),
        );
      };
      if (
        !timingSafeEqual(
          expectedAuthorization,
          createHash('sha256')
            .update(incoming.headers.authorization ?? '')
            .digest(),
        )
      ) {
        deny(401, 'A Runtime access token is required.');
        incoming.resume();
        return;
      }
      if (!incoming.url?.startsWith('/local/') || incoming.url.includes('\\')) {
        deny(404, 'Only local Runtime routes are exposed.');
        incoming.resume();
        return;
      }
      try {
        let replacement: string | undefined;
        const route = new URL(incoming.url, 'http://localhost').pathname;
        // Reject encoded/ambiguous route spellings before Express can normalize them differently.
        if (/%(?:2e|2f|5c)|\/\//iu.test(route) || route.endsWith('/')) {
          deny(400, 'Non-canonical Runtime route.');
          return;
        }
        if (incoming.method === 'POST' && route.toLowerCase() === '/local/workspaces/grants') {
          const grant = createWorkspaceGrantRequestSchema.parse(
            JSON.parse((await boundedBody(incoming, 16384)).toString()),
          );
          const requested = await realpath(path.resolve(grant.path));
          // Exact roots only: no implicit parent share, path-prefix approximation, or symlink escape.
          const share = shares.find((entry) => entry.name.startsWith('workspace-') && entry.path === requested);
          if (!share) {
            deny(403, 'This directory was not explicitly shared when the VM was started.');
            return;
          }
          replacement = JSON.stringify({ ...grant, path: '/harness-shares/' + share.name });
        }
        const headers = { ...incoming.headers, host: new URL(descriptor.origin).host };
        delete headers.connection;
        if (replacement !== undefined) {
          headers['content-length'] = String(Buffer.byteLength(replacement));
          delete headers['transfer-encoding'];
        }
        const upstream = request(
          { socketPath: socket, path: incoming.url, method: incoming.method, headers, agent: false },
          (response) => {
            outgoing.writeHead(response.statusCode ?? 502, response.headers);
            response.pipe(outgoing);
            outgoing.once('close', () => response.destroy());
          },
        );
        upstream.once('error', () => outgoing.destroy());
        outgoing.once('close', () => upstream.destroy());
        incoming.once('aborted', () => upstream.destroy());
        if (replacement === undefined) incoming.pipe(upstream);
        else upstream.end(replacement);
      } catch {
        deny(400, 'Invalid VM workspace or request.');
      }
    });
    proxy.maxConnections = 32;
    proxy.headersTimeout = 10000;
    proxy.requestTimeout = 30000;
    await abortable(
      new Promise<void>((resolve, reject) => {
        proxy!.once('error', reject);
        proxy!.listen(0, '127.0.0.1', resolve);
      }),
      signal,
    );
    const address = proxy.address();
    if (!address || typeof address === 'string') throw new Error();
    const origin = 'http://127.0.0.1:' + address.port;
    const hostDescriptor = {
      schemaVersion: 1,
      instanceId,
      pid: child.pid!,
      origin,
      accessToken: descriptor.accessToken,
      expiresAt: descriptor.expiresAt,
    };
    await writeFile(descriptorPath, JSON.stringify(hostDescriptor), { flag: 'wx', mode: 0o600 });
    const client = new HarnessClient({
      origin,
      accessToken: descriptor.accessToken,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    await abortable(client.health({ signal }), signal);
    signal.throwIfAborted();
    if (child.exitCode !== null || child.signalCode !== null) throw new Error();
    const ownedControl = control;
    let closing: Promise<void> | undefined;
    return {
      client,
      origin,
      pid: child.pid!,
      descriptorPath,
      close() {
        closing ??= (async () => {
          stopProxy();
          const deadline = Date.now() + shutdownTimeoutMs;
          // The private route is never exposed by the public proxy; guest Runtime owns business shutdown.
          await privateJson(
            socket,
            '/__harness/shutdown',
            {},
            AbortSignal.timeout(Math.max(1, Math.floor(shutdownTimeoutMs * 0.3))),
          ).catch(() => undefined);
          await ownedControl.stop(Math.max(1, deadline - Date.now()), true);
          await removeDescriptor(descriptorPath, instanceId!);
          await rm(configPath!, { force: true });
          if (ownsRoot) await rm(root, { recursive: true, force: true });
        })();
        return closing;
      },
    };
  } catch (error) {
    stopProxy();
    if (control) await control.stop(shutdownTimeoutMs); // Failure deliberately retains owned evidence/state.
    if (instanceId) await removeDescriptor(descriptorPath, instanceId);
    if (configPath) await rm(configPath, { force: true });
    if (ownsRoot) await rm(root, { recursive: true, force: true });
    if (signal.aborted) throw signal.reason;
    if (error instanceof HarnessSdkError) throw error;
    throw new HarnessSdkError(
      'runtime',
      'VM Runtime failed to start; verify guest artifacts and explicit resource mappings.',
    );
  }
}

export async function workspaceShares(workspaces: NonNullable<VMOptions['workspaces']>) {
  if (workspaces.length > 31) throw new HarnessSdkError('request', 'At most 31 explicit VM workspaces are allowed.');
  const shares: { name: string; path: string; readOnly: boolean }[] = [];
  for (const [index, workspace] of workspaces.entries()) {
    if (!path.isAbsolute(workspace.path) || typeof workspace.readOnly !== 'boolean')
      throw new HarnessSdkError('request', 'An absolute VM workspace and readOnly flag are required.');
    const canonical = await realpath(workspace.path);
    if (
      canonical === '/' ||
      canonical === (await realpath(homedir())) ||
      !(await lstat(canonical)).isDirectory() ||
      shares.some((entry) => entry.path === canonical)
    )
      throw new HarnessSdkError('request', 'A dedicated, unique VM workspace directory is required.');
    shares.push({ name: 'workspace-' + index, path: canonical, readOnly: workspace.readOnly });
  }
  return shares;
}

export async function vmEnvironment(environment: Readonly<Record<string, string | undefined>>) {
  const selected: Record<string, string> = {};
  for (const key of [
    'CODEBUDDY_API_KEY',
    'CODEBUDDY_INTERNET_ENVIRONMENT',
    'CODEBUDDY_BASE_URL',
    'YANBOT_HARNESS_REFERENCE_SCENARIO',
  ]) {
    const value = environment[key];
    if (value !== undefined) {
      if (value.length > 16384 || value.includes('\0'))
        throw new HarnessSdkError('request', 'Invalid VM environment value.');
      selected[key] = value;
    }
  }
  if (environment.CODEBUDDY_CODE_PATH)
    throw new HarnessSdkError('request', 'VM mode cannot execute a host-side vendor code path.');
  const file = environment.CODEBUDDY_API_KEY_FILE;
  if (file) {
    if (selected.CODEBUDDY_API_KEY)
      throw new HarnessSdkError('request', 'Configure exactly one Runtime credential source.');
    const handle = await open(path.resolve(file), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.uid !== process.getuid!() || info.mode & 0o077 || info.size < 1 || info.size > 16384)
        throw new Error();
      const bytes = Buffer.alloc(16385);
      let size = 0;
      while (size < bytes.length) {
        const part = await handle.read(bytes, size, bytes.length - size, null);
        if (!part.bytesRead) break;
        size += part.bytesRead;
      }
      if (size > 16384) throw new Error();
      const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)).replace(/\r?\n$/u, '');
      if (!value || /[\0\r\n]/u.test(value)) throw new Error();
      selected.CODEBUDDY_API_KEY = value;
    } catch {
      throw new HarnessSdkError('authentication', 'VM credential must be a private, bounded, one-line regular file.');
    } finally {
      await handle.close();
    }
  }
  return selected;
}

function vmControl(child: ChildProcess) {
  let accept!: (socket: string) => void;
  let reject!: (error: Error) => void;
  const ready = new Promise<string>((resolve, fail) => {
    accept = resolve;
    reject = fail;
  });
  void ready.catch(() => undefined);
  let buffer = '';
  let total = 0;
  let started = false;
  let transport = false;
  let guest = false;
  let stopped = false;
  let failure = false;
  let recoveryRequired = false;
  const invalid = () => {
    failure = true;
    reject(new HarnessSdkError('protocol', 'Invalid VM host lifecycle.'));
    child.stdin?.destroy();
  };
  child.stdout?.setEncoding('utf8');
  child.stderr?.resume();
  child.stdin?.on('error', () => undefined);
  child.stdout?.on('data', (chunk: string) => {
    total += Buffer.byteLength(chunk);
    if (total > 16384 || failure) {
      invalid();
      return;
    }
    buffer += chunk;
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n');
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        const message = JSON.parse(line);
        if (message.protocolVersion !== 1 || stopped) throw new Error();
        const fields: Record<string, string[]> = {
          started: ['boundary', 'hostPid', 'protocolVersion', 'type'],
          'transport-ready': ['protocolVersion', 'socketPath', 'type'],
          'guest-ready': ['certification', 'guestTarget', 'protocolVersion', 'type'],
          stopped: ['guestReady', 'protocolVersion', 'state', 'type'],
          'guest-fault': ['kind', 'protocolVersion', 'type'],
        };
        if (
          message.type === 'error' &&
          !started &&
          message.stage === 'state-recovery-required' &&
          Object.keys(message).sort().join(',') === 'protocolVersion,stage,type'
        ) {
          recoveryRequired = true;
          throw new Error();
        }
        if (!fields[message.type] || Object.keys(message).sort().join(',') !== fields[message.type]!.join(','))
          throw new Error();
        if (
          message.type === 'started' &&
          !started &&
          message.hostPid === child.pid &&
          message.boundary === 'virtual-machine'
        )
          started = true;
        else if (
          message.type === 'transport-ready' &&
          started &&
          !transport &&
          typeof message.socketPath === 'string' &&
          /^\/private\/tmp\/hvm-[0-9A-F-]{36}\/http\.sock$/u.test(message.socketPath)
        ) {
          transport = true;
          accept(message.socketPath);
        } else if (message.type === 'guest-ready' && started && !guest && message.guestTarget === 'linux-arm64')
          guest = true;
        else if (message.type === 'stopped' && started && message.state === 'stopped' && message.guestReady === guest)
          stopped = true;
        else if (message.type === 'guest-fault' && started && message.kind === 'kernel-panic') {
          // The heartbeat watchdog owns VM stop; this fixed diagnostic contains no guest console text.
        } else throw new Error();
      } catch {
        invalid();
      }
    }
  });
  const closed = new Promise<void>((resolve, fail) => {
    child.once('error', () => {
      invalid();
      fail(new HarnessSdkError('runtime', 'VM host could not start.'));
    });
    child.once('close', (code, signal) => {
      reject(new HarnessSdkError('runtime', 'VM host exited before readiness.'));
      if (recoveryRequired) {
        fail(
          new HarnessSdkError(
            'runtime',
            'STATE_RECOVERY_REQUIRED: the previous VM host did not confirm state release; use a fresh state root or explicitly recover the retained instance.',
          ),
        );
        return;
      }
      if (failure || code !== 0 || signal !== null || !stopped || buffer.length)
        fail(new HarnessSdkError('runtime', 'CLEANUP_FAILED: VM host provided no stopped proof; state retained.'));
      else resolve();
    });
  });
  void closed.catch(() => undefined);
  return {
    ready,
    async stop(timeout: number, graceful = false) {
      let timer: NodeJS.Timeout | undefined;
      try {
        if (graceful) {
          const done = await Promise.race([
            closed.then(() => true),
            new Promise<false>((resolve) => {
              timer = setTimeout(() => resolve(false), Math.max(1, Math.floor(timeout * 0.5)));
            }),
          ]);
          clearTimeout(timer);
          if (done) return;
          timeout = Math.max(1, Math.floor(timeout * 0.5));
        }
        child.stdin?.end('stop\n');
        await Promise.race([
          closed,
          new Promise<never>((_, fail) => {
            timer = setTimeout(
              () => fail(new HarnessSdkError('runtime', 'CLEANUP_FAILED: VM stop timed out; state retained.')),
              timeout,
            );
          }),
        ]);
      } catch (error) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
async function boundedBody(stream: IncomingMessage, maximum: number) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > maximum) throw new Error();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
type VMReadiness = {
  runtimeVersion: string;
  protocolVersion: string;
  descriptor: {
    schemaVersion: number;
    pid: number;
    instanceId: string;
    accessToken: string;
    origin: string;
    expiresAt: string;
  };
};
async function privateJson(socket: string, route: string, body: unknown, signal: AbortSignal): Promise<VMReadiness> {
  return new Promise((resolve, reject) => {
    const call = request(
      {
        socketPath: socket,
        path: route,
        method: 'POST',
        agent: false,
        signal,
        headers: { 'content-type': 'application/json' },
      },
      (response) => {
        void boundedBody(response, 16384)
          .then((bytes) => {
            if (response.statusCode !== 200) throw new Error();
            resolve(JSON.parse(bytes.toString()));
          })
          .catch(reject);
      },
    );
    call.once('error', reject);
    call.end(JSON.stringify(body));
  });
}
async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let aborted!: () => void;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        aborted = () => reject(signal.reason);
        signal.addEventListener('abort', aborted, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', aborted);
  }
}
async function removeDescriptor(file: string, identity: string) {
  const value = JSON.parse(await readFile(file, 'utf8').catch(() => '{}'));
  if (value.instanceId === identity) await rm(file, { force: true });
}
