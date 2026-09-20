import { Catch, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { apiErrorSchema, uuidSchema } from '@yanbot-harness/contracts';
import type { Response } from 'express';
import { ZodError } from 'zod';

import { CloudError } from './cloud-error.js';

@Catch()
export class CloudExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const id = uuidSchema.parse(response.locals.requestId);
    const normalized =
      error instanceof CloudError
        ? error
        : isPayloadTooLarge(error)
          ? new CloudError(413, 'CONFIGURATION_INVALID', 'The request exceeds the service limits.')
          : error instanceof ZodError
            ? new CloudError(400, 'CONFIGURATION_INVALID', 'The request is invalid.')
            : new CloudError(500, 'INTERNAL_ERROR', 'The service could not complete the request.', true);
    response.status(normalized.status).json(
      apiErrorSchema.parse({
        requestId: id,
        error: { code: normalized.code, message: normalized.message, retryable: normalized.retryable },
      }),
    );
  }
}

function isPayloadTooLarge(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    error.status === 413 &&
    'type' in error &&
    error.type === 'entity.too.large'
  );
}
