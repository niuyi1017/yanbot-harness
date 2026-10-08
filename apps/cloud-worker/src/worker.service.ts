import { reapUnstartedContainers } from '@yanbot-harness/sandbox-docker';

import {
  createQueueConnection,
  createRemoteRunWorker,
  type RemoteQueueConnection,
  type RemoteRunWorker,
} from '@yanbot-harness/cloud-queue';

import type { WorkerConfig } from './config.js';
import { RunCoordinator } from './run-coordinator.js';

export class CloudWorkerService {
  readonly #connection: RemoteQueueConnection;
  #worker: RemoteRunWorker | undefined;
  #reaper: NodeJS.Timeout | undefined;
  #reaping = false;

  constructor(
    private readonly config: WorkerConfig,
    private readonly coordinator = new RunCoordinator(config),
  ) {
    this.#connection = createQueueConnection(config.redisUrl);
  }

  async start(): Promise<void> {
    if (this.config.sandbox) {
      const dockerPath = this.config.sandbox.dockerPath;
      await reapUnstartedContainers(dockerPath);
      this.#reaper = setInterval(() => {
        if (this.#reaping) return;
        this.#reaping = true;
        void reapUnstartedContainers(dockerPath)
          .catch(() => {
            process.stderr.write('Sandbox abandoned-create cleanup failed.\n');
          })
          .finally(() => {
            this.#reaping = false;
          });
      }, 15_000);
      this.#reaper.unref();
    }
    await this.#connection.connect();
    this.#worker = createRemoteRunWorker(
      this.config.queueName,
      this.#connection,
      (job) => this.coordinator.process(job),
      this.config.concurrency,
    );
    await this.#worker.waitUntilReady();
  }

  async close(): Promise<void> {
    clearInterval(this.#reaper);
    if (this.#worker) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        this.#worker.close(),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => void this.#worker?.close(true).then(resolve), this.config.shutdownMs);
          timer.unref();
        }),
      ]);
      if (timer) clearTimeout(timer);
    }
    await this.#connection.quit();
  }

  status(): { started: boolean } {
    return { started: this.#worker !== undefined };
  }
}
