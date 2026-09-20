import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { z } from 'zod';

import { AppModule } from '../app.module.js';
import { AuthService } from '../auth/auth.service.js';
import { parseCloudConfig } from '../config.js';

const inputSchema = z.object({
  organizationId: z.string().uuid(),
  organizationName: z.string().trim().min(1).max(256),
  userId: z.string().uuid(),
  userDisplayName: z.string().trim().min(1).max(256),
  deviceId: z.string().uuid(),
  roles: z.array(z.enum(['owner', 'admin', 'member'])).min(1),
});

const input = inputSchema.parse({
  organizationId: process.env.CLOUD_PROVISION_ORGANIZATION_ID,
  organizationName: process.env.CLOUD_PROVISION_ORGANIZATION_NAME,
  userId: process.env.CLOUD_PROVISION_USER_ID,
  userDisplayName: process.env.CLOUD_PROVISION_USER_DISPLAY_NAME,
  deviceId: process.env.CLOUD_PROVISION_DEVICE_ID,
  roles: process.env.CLOUD_PROVISION_ROLES?.split(',').map((role) => role.trim()),
});
const application = await NestFactory.createApplicationContext(AppModule.forRoot(parseCloudConfig(process.env)), {
  logger: false,
});
try {
  const result = await application.get(AuthService).provision(input);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await application.close();
}
