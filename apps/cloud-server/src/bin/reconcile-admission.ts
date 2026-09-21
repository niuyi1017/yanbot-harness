import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { z } from 'zod';

import { AdmissionService } from '../admission/admission.service.js';
import { AppModule } from '../app.module.js';
import { parseCloudConfig } from '../config.js';

const arguments_ = z
  .array(z.enum(['--apply']))
  .max(1)
  .parse(process.argv.slice(2));
const limit = z.coerce
  .number()
  .int()
  .min(1)
  .max(10_000)
  .default(1_000)
  .parse(process.env.CLOUD_ADMISSION_RECONCILE_LIMIT);
const application = await NestFactory.createApplicationContext(AppModule.forRoot(parseCloudConfig(process.env)), {
  logger: false,
});
try {
  const results = await application.get(AdmissionService).reconcile({
    limit,
    apply: arguments_.includes('--apply'),
  });
  for (const result of results) process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await application.close();
}
