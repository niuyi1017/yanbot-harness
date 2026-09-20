import { Body, Controller, Get, Headers, Inject, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';

import { authenticationFailed } from '../common/cloud-error.js';
import { requestId } from '../common/request-context.js';
import { ExecutionGrantService } from './execution-grant.service.js';

@Controller('/internal/v1')
export class ExecutionGrantController {
  constructor(@Inject(ExecutionGrantService) private readonly grants: ExecutionGrantService) {}

  @Post('/execution-grants/claim')
  claim(@Headers('authorization') authorization: string | undefined, @Res({ passthrough: true }) response: Response) {
    return this.grants.claim(grant(authorization), requestId(response));
  }

  @Get('/runs/:runId/workspace')
  workspace(
    @Param('runId') runId: string,
    @Query('attempt') attempt: string,
    @Headers('authorization') authorization: string | undefined,
  ) {
    return this.grants.workspace(grant(authorization), runId, integer(attempt));
  }

  @Get('/runs/:runId/interactions/:requestId')
  interaction(
    @Param('runId') runId: string,
    @Param('requestId') requestId: string,
    @Query('attempt') attempt: string,
    @Headers('authorization') authorization: string | undefined,
  ) {
    return this.grants.interaction(grant(authorization), runId, integer(attempt), requestId);
  }

  @Post('/runs/:runId/events')
  append(
    @Param('runId') runId: string,
    @Query('attempt') attempt: string,
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
  ) {
    return this.grants.append(grant(authorization), runId, integer(attempt), body);
  }
}

function grant(authorization: string | undefined): string {
  const match = /^Bearer (yhe_[A-Za-z0-9_-]{43})$/u.exec(authorization ?? '');
  if (!match?.[1]) throw authenticationFailed();
  return match[1];
}

function integer(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw authenticationFailed();
  return parsed;
}
