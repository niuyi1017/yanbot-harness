import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { AppModule } from '../app.module.js';
import { parseCloudConfig } from '../config.js';
import { MongoService } from '../persistence/mongo.service.js';

const application = await NestFactory.createApplicationContext(AppModule.forRoot(parseCloudConfig(process.env)), {
  logger: false,
});
try {
  await application.get(MongoService).syncIndexes();
  process.stdout.write(`${JSON.stringify({ synced: true })}\n`);
} finally {
  await application.close();
}
