import { Controller, Get, Inject } from '@nestjs/common';
import { HARNESS_PROTOCOL_VERSION, HARNESS_RELEASE_VERSION, runtimeDiscoverySchema } from '@yanbot-harness/contracts';

import type { CloudConfig } from './config.js';
import { CLOUD_CONFIG } from './persistence/mongo.service.js';

@Controller('/v1')
export class HealthController {
  readonly #config: CloudConfig;
  readonly #startedAt = new Date().toISOString();

  constructor(@Inject(CLOUD_CONFIG) config: CloudConfig) {
    this.#config = config;
  }

  @Get('/health')
  health(): unknown {
    return runtimeDiscoverySchema.parse({
      service: 'yanbot-harness-cloud-server',
      protocolVersion: HARNESS_PROTOCOL_VERSION,
      status: 'ok',
      startedAt: this.#startedAt,
      profile: {
        executionMode: 'remote',
        serviceVersion: HARNESS_RELEASE_VERSION,
        authentication: 'bearer',
        capabilities: {
          workspaceSources:
            this.#config.gitAllowedHosts.length > 0 ? ['uploaded-snapshot', 'git-ref'] : ['uploaded-snapshot'],
          eventReplay: { durability: 'durable', retentionSeconds: this.#config.eventRetentionSeconds },
          interactions: { supported: true, maxWaitSeconds: 86_400 },
        },
      },
    });
  }
}
