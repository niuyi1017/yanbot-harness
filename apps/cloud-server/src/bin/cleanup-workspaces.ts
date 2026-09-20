import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { z } from 'zod';

import { AppModule } from '../app.module.js';
import { parseCloudConfig } from '../config.js';
import { WorkspaceService } from '../workspaces/workspace.service.js';

const limit = z.coerce.number().int().min(1).max(10_000).default(100).parse(process.env.CLOUD_CLEANUP_LIMIT);
const application = await NestFactory.createApplicationContext(AppModule.forRoot(parseCloudConfig(process.env)), {
  logger: false,
});
try {
  const cleaned = await application.get(WorkspaceService).cleanupExpired(limit);
  process.stdout.write(`${JSON.stringify({ cleaned })}\n`);
} finally {
  await application.close();
}
