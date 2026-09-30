import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { HarnessAdapterError, type AdapterRuntimeContext, type HarnessAdapter } from '@yanbot-harness/adapter-api';
import { SidecarAdapter } from '@yanbot-harness/adapter-sidecar';
import { createWindowsCliJobOwner } from '@yanbot-harness/adapter-cli-host';
import { manifest } from './manifest.js';
import type { ClaudeDeployment } from './execute.js';

export { CLAUDE_CODE_VERSION } from './manifest.js';
export type { ClaudeDeployment } from './execute.js';

/** Trusted Runtime deployment configuration; never accepted from an SDK run request. */
export class ClaudeCodeCliAdapter implements HarnessAdapter {
  readonly manifest = manifest;
  readonly #bridge: SidecarAdapter;
  constructor(deployment: ClaudeDeployment) {
    if (
      !path.isAbsolute(deployment.executablePath) ||
      deployment.executablePath.includes('\0') ||
      (deployment.apiKey !== undefined &&
        (!deployment.apiKey || deployment.apiKey.length > 8192 || /[\r\n\0]/.test(deployment.apiKey)))
    ) {
      throw new HarnessAdapterError({
        code: 'CONFIGURATION_INVALID',
        message: 'Invalid Claude Code deployment configuration.',
        retryable: false,
      });
    }
    this.#bridge = new SidecarAdapter({
      manifest,
      launch: {
        executablePath: process.execPath,
        args: [fileURLToPath(new URL('./wrapper.js', import.meta.url))],
        environment: {
          HARNESS_CLAUDE_EXECUTABLE: deployment.executablePath,
          TMPDIR: tmpdir(),
          TEMP: tmpdir(),
          TMP: tmpdir(),
          ...(deployment.apiKey ? { ANTHROPIC_API_KEY: deployment.apiKey } : {}),
          ...(process.platform === 'win32' && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
          ...(deployment.windowsJobHost ? { HARNESS_CLI_JOB_HOST: deployment.windowsJobHost } : {}),
        },
        ...(process.platform === 'win32' && deployment.windowsJobHost
          ? { processOwner: createWindowsCliJobOwner(deployment.windowsJobHost) }
          : {}),
        clientName: 'yanbot-harness',
        clientVersion: manifest.adapterVersion,
        requestTimeoutMs: 30_000,
      },
    });
  }
  probe(context: AdapterRuntimeContext) {
    return this.#bridge.probe(context);
  }
  createRuntime(context: AdapterRuntimeContext) {
    return this.#bridge.createRuntime(context);
  }
}
