import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { json } from 'express';

import { AppModule } from './app.module.js';
import { CloudExceptionFilter } from './common/cloud-exception.filter.js';
import { parseCloudConfig } from './config.js';

const config = parseCloudConfig(process.env);
const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config), {
  bodyParser: false,
});
app.disable('x-powered-by');
app.set('trust proxy', config.trustProxy);
app.use(json({ limit: '90mb', strict: true }));
app.useGlobalFilters(new CloudExceptionFilter());
app.enableShutdownHooks();
await app.listen(config.port, config.host);
