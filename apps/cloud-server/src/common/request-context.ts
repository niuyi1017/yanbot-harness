import { randomUUID } from 'node:crypto';

import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import { uuidSchema } from '@yanbot-harness/contracts';
import type { NextFunction, Request, Response } from 'express';

import type { TenantPrincipal } from '../domain.js';
import type { CloudConfig } from '../config.js';
import { invalidConfiguration } from './cloud-error.js';
import { CLOUD_CONFIG } from '../persistence/mongo.service.js';

export type CloudRequest = Request & { cloudPrincipal?: TenantPrincipal };

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(_request: CloudRequest, response: Response, next: NextFunction): void {
    const id = uuidSchema.parse(randomUUID());
    response.locals.requestId = id;
    response.setHeader('X-Request-Id', id);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  }
}

@Injectable()
export class ProductionHttpsMiddleware implements NestMiddleware {
  constructor(@Inject(CLOUD_CONFIG) private readonly config: CloudConfig) {}

  use(request: CloudRequest, _response: Response, next: NextFunction): void {
    if (this.config.nodeEnv === 'production' && !request.secure) {
      throw invalidConfiguration('HTTPS is required.');
    }
    next();
  }
}

export function requestId(response: Response): string {
  return uuidSchema.parse(response.locals.requestId);
}
