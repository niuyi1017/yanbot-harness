import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';

import { AuditService } from '../audit/audit.service.js';
import { AccessTokenGuard } from '../auth/auth.guard.js';
import type { CloudRequest } from '../common/request-context.js';
import { requestId } from '../common/request-context.js';
import { invalidConfiguration } from '../common/cloud-error.js';
import type { TenantPrincipal } from '../domain.js';
import { ControlPlaneService } from './control-plane.service.js';

@Controller('/v1')
@UseGuards(AccessTokenGuard)
export class ControlPlaneController {
  readonly #controlPlane: ControlPlaneService;
  readonly #audit: AuditService;

  constructor(
    @Inject(ControlPlaneService) controlPlane: ControlPlaneService,
    @Inject(AuditService) audit: AuditService,
  ) {
    this.#controlPlane = controlPlane;
    this.#audit = audit;
  }

  @Get('/adapters')
  listAdapters() {
    return this.#controlPlane.listAdapters();
  }

  @Get('/models')
  listModels(@Query('adapterId') adapterId: string) {
    return this.#controlPlane.listModels(adapterId);
  }

  @Post('/sessions')
  createSession(@Body() body: unknown, @Req() request: CloudRequest, @Res({ passthrough: true }) response: Response) {
    return this.#audited('session.create', principal(request), response, 201, () =>
      this.#controlPlane.createSession(principal(request), body),
    );
  }

  @Get('/sessions')
  listSessions(@Req() request: CloudRequest) {
    return this.#controlPlane.listSessions(principal(request));
  }

  @Get('/sessions/:sessionId')
  getSession(@Param('sessionId') sessionId: string, @Req() request: CloudRequest) {
    return this.#controlPlane.getSession(principal(request), sessionId);
  }

  @Post('/sessions/:sessionId/runs')
  createRun(
    @Param('sessionId') sessionId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: CloudRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (idempotencyKey !== undefined && (idempotencyKey.length === 0 || idempotencyKey.length > 256)) {
      throw invalidConfiguration('The idempotency key is invalid.');
    }
    return this.#audited('run.create', principal(request), response, 201, () =>
      this.#controlPlane.createRun(principal(request), sessionId, body, idempotencyKey),
    );
  }

  @Get('/runs/:runId')
  getRun(@Param('runId') runId: string, @Req() request: CloudRequest) {
    return this.#controlPlane.getRun(principal(request), runId);
  }

  @Post('/runs/:runId/cancel')
  cancelRun(
    @Param('runId') runId: string,
    @Body() body: { reason?: string },
    @Req() request: CloudRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.#audited('run.cancel', principal(request), response, 200, () =>
      this.#controlPlane.cancelRun(principal(request), runId, body.reason),
    );
  }

  @Post('/interactions/:requestId/responses')
  @HttpCode(204)
  async respond(
    @Param('requestId') interactionRequestId: string,
    @Body() body: unknown,
    @Req() request: CloudRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.#audited('interaction.respond', principal(request), response, 204, () =>
      this.#controlPlane.respond(principal(request), interactionRequestId, body),
    );
  }

  @Get('/runs/:runId/events')
  async events(
    @Param('runId') runId: string,
    @Query('afterEventId') afterEventId: string | undefined,
    @Headers('last-event-id') lastEventId: string | undefined,
    @Req() request: CloudRequest,
    @Res() response: Response,
  ): Promise<void> {
    response.status(200);
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.setHeader('Connection', 'keep-alive');
    response.flushHeaders();
    let cursor = afterEventId ?? lastEventId;
    const deadline = Date.now() + 25_000;
    while (!response.destroyed && Date.now() < deadline) {
      const events = await this.#controlPlane.listEvents(principal(request), runId, cursor);
      for (const event of events) {
        response.write(`id: ${event.eventId}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        cursor = event.eventId;
      }
      if (
        events.some(
          (event) =>
            event.type.startsWith('run.') && ['run.completed', 'run.failed', 'run.cancelled'].includes(event.type),
        )
      )
        break;
      response.write(': heartbeat\n\n');
      await delay(1_000);
    }
    response.end();
  }

  async #audited<T>(
    action: string,
    authenticated: TenantPrincipal,
    response: Response,
    successStatus: number,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      const result = await operation();
      response.status(successStatus);
      await this.#audit.record({
        requestId: requestId(response),
        principal: authenticated,
        action,
        outcome: 'succeeded',
        status: successStatus,
      });
      return result;
    } catch (error) {
      await this.#audit.record({
        requestId: requestId(response),
        principal: authenticated,
        action,
        outcome: 'rejected',
        status: 400,
      });
      throw error;
    }
  }
}

function principal(request: CloudRequest): TenantPrincipal {
  if (!request.cloudPrincipal) throw new Error('The access guard did not establish a principal.');
  return request.cloudPrincipal;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
