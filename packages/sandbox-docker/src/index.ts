import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import {
  HarnessAdapterError,
  type AdapterRuntimeContext,
  type AdapterRuntime,
  type HarnessAdapter,
} from '@yanbot-harness/adapter-api';
import { SidecarAdapter, type SidecarProcessOwner } from '@yanbot-harness/adapter-sidecar';
import type { AdapterManifest } from '@yanbot-harness/contracts';
import { readSnapshot } from './snapshot.js';
import { createArguments, type SandboxDeployment } from './policy.js';

export type { SandboxDeployment } from './policy.js';
const execute = promisify(execFile);
const environment = { PATH: '/usr/bin:/bin' };
function failure() {
  return new HarnessAdapterError({
    code: 'HARNESS_FAILED',
    message: 'Sandbox execution or cleanup could not be verified.',
    retryable: false,
  });
}

/** Container policy is deployment-only. The guest receives no control-plane credentials. */
export class DockerSandboxAdapter implements HarnessAdapter {
  readonly manifest: AdapterManifest;
  readonly #containers = new Set<string>();
  ownedContainerIds(): readonly string[] {
    return [...this.#containers];
  }
  constructor(
    private readonly deployment: SandboxDeployment,
    manifest: AdapterManifest,
  ) {
    this.manifest = { ...manifest, runtimeKinds: ['sidecar'] };
  }
  async probe(context: AdapterRuntimeContext) {
    const owned = await this.#bridge(context);
    try {
      return await owned.bridge.probe({});
    } finally {
      await owned.cleanup();
    }
  }
  async createRuntime(context: AdapterRuntimeContext): Promise<AdapterRuntime> {
    const owned = await this.#bridge(context);
    try {
      const runtime = await owned.bridge.createRuntime({});
      return {
        ...runtime,
        dispose: async () => {
          try {
            await runtime.dispose();
          } finally {
            await owned.cleanup();
          }
        },
      };
    } catch (error) {
      await owned.cleanup();
      throw error;
    }
  }
  async #bridge(context: AdapterRuntimeContext) {
    if (Object.keys(context.config ?? {}).length || Object.keys(context.credentials ?? {}).length) {
      throw new HarnessAdapterError({
        code: 'CAPABILITY_UNSUPPORTED',
        message: 'Sandbox credential and config injection is not enabled.',
        retryable: false,
      });
    }
    const name = `harness-sandbox-${randomUUID()}`;
    let cid: string | undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    let child: ChildProcess | undefined;
    let cleanupPromise: Promise<void> | undefined;
    const command = async (args: string[]) =>
      (
        await execute(this.deployment.dockerPath, args, {
          env: environment,
          timeout: 15_000,
          maxBuffer: 64 * 1024,
          windowsHide: true,
        })
      ).stdout.trim();
    const cleanup = () =>
      (cleanupPromise ??= (async () => {
        clearInterval(heartbeat);
        if (!cid) return;
        await command(['rm', '--force', cid]).catch(() => undefined);
        let remaining: string;
        try {
          remaining = await command(['ps', '--all', '--no-trunc', '--filter', `id=${cid}`, '--format', '{{.ID}}']);
        } catch {
          throw failure();
        }
        if (remaining) throw failure();
        this.#containers.delete(cid);
        if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      })());
    const policy = await createArguments(this.deployment, name).catch(() => {
      throw failure();
    });
    const snapshot = await readSnapshot(policy.workspace).catch(() => {
      throw failure();
    });
    try {
      if ((await command(['info', '--format', '{{.OSType}}'])) !== 'linux') throw failure();
      cid = await command(policy.args);
      if (!/^[a-f0-9]{64}$/.test(cid)) {
        cid = undefined;
        throw failure();
      }
      this.#containers.add(cid);
      const containerId = cid;
      const owner: SidecarProcessOwner = {
        spawn: () => {
          child = spawn(this.deployment.dockerPath, ['start', '--attach', '--interactive', containerId], {
            env: environment,
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: false,
            windowsHide: true,
          });
          // Boot is private launcher metadata; all following frames use public Sidecar schemas.
          child.stdin!.write(
            `${JSON.stringify({ method: 'boot', adapterId: this.manifest.adapterId, files: snapshot })}\n`,
          );
          heartbeat = setInterval(() => {
            if (child?.stdin?.writable) child.stdin.write('{"method":"lease"}\n');
          }, 2_000);
          heartbeat.unref();
          child.once('close', () => clearInterval(heartbeat));
          return child;
        },
        terminate: async () => {
          await cleanup();
        },
        verifyClosed: async () => {
          await cleanup();
        },
      };
      return {
        cleanup,
        bridge: new SidecarAdapter({
          manifest: this.manifest,
          launch: {
            executablePath: this.deployment.dockerPath,
            args: [],
            environment,
            processOwner: owner,
            clientName: 'yanbot-remote-worker',
            clientVersion: '0.1.0',
            requestTimeoutMs: 15_000,
          },
        }),
      };
    } catch {
      // A failed CLI request can have reached the daemon. Resolve our unique name before cleanup.
      if (!cid) {
        try {
          const ownedId = await command([
            'ps',
            '--all',
            '--no-trunc',
            '--filter',
            `name=^/${name}$`,
            '--filter',
            'label=io.yanbot.harness.sandbox=1',
            '--format',
            '{{.ID}}',
          ]);
          if (/^[a-f0-9]{64}$/.test(ownedId)) cid = ownedId;
        } catch {
          throw failure();
        }
      }
      await cleanup();
      throw failure();
    }
  }
}
