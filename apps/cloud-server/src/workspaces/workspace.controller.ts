import { Body, Controller, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';

import { AuditService } from '../audit/audit.service.js';
import { AccessTokenGuard } from '../auth/auth.guard.js';
import type { CloudRequest } from '../common/request-context.js';
import { requestId } from '../common/request-context.js';
import type { TenantPrincipal, WorkspaceRecord } from '../domain.js';
import { WorkspaceService } from './workspace.service.js';

@Controller('/v1/workspaces')
@UseGuards(AccessTokenGuard)
export class WorkspaceController {
  readonly #workspaces: WorkspaceService;
  readonly #audit: AuditService;

  constructor(@Inject(WorkspaceService) workspaces: WorkspaceService, @Inject(AuditService) audit: AuditService) {
    this.#workspaces = workspaces;
    this.#audit = audit;
  }

  @Post('/snapshots')
  async snapshot(
    @Body() body: unknown,
    @Req() request: CloudRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    return this.#prepare('workspace.snapshot.prepare', principal(request), response, () =>
      this.#workspaces.prepareSnapshot(principal(request), body),
    );
  }

  @Post('/git')
  async git(
    @Body() body: unknown,
    @Req() request: CloudRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    return this.#prepare('workspace.git.prepare', principal(request), response, () =>
      this.#workspaces.prepareGit(principal(request), body),
    );
  }

  async #prepare(
    action: string,
    authenticated: TenantPrincipal,
    response: Response,
    operation: () => Promise<WorkspaceRecord>,
  ): Promise<unknown> {
    try {
      const record = await operation();
      response.status(201);
      await this.#audit.record({
        requestId: requestId(response),
        principal: authenticated,
        action,
        resourceType: 'workspace',
        resourceId: record.workspaceRef,
        outcome: 'succeeded',
        status: 201,
      });
      return { workspace: record.source, workspaceRef: record.workspaceRef, expiresAt: record.expiresAt.toISOString() };
    } catch (error) {
      await this.#audit.record({
        requestId: requestId(response),
        principal: authenticated,
        action,
        outcome: 'rejected',
        status: 422,
      });
      throw error;
    }
  }
}

function principal(request: CloudRequest): TenantPrincipal {
  if (!request.cloudPrincipal) throw new Error('The access guard did not establish a principal.');
  return request.cloudPrincipal;
}
