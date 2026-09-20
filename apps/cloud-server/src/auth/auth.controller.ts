import { Body, Controller, HttpCode, Inject, Post, Res } from '@nestjs/common';
import type { Response } from 'express';

import { AuditService } from '../audit/audit.service.js';
import { requestId } from '../common/request-context.js';
import { AuthService } from './auth.service.js';

@Controller('/v1/auth')
export class AuthController {
  readonly #auth: AuthService;
  readonly #audit: AuditService;

  constructor(@Inject(AuthService) auth: AuthService, @Inject(AuditService) audit: AuditService) {
    this.#auth = auth;
    this.#audit = audit;
  }

  @Post('/device/exchange')
  @HttpCode(200)
  async exchange(@Body() body: unknown, @Res({ passthrough: true }) response: Response): Promise<unknown> {
    return this.#audited('auth.device.exchange', response, () => this.#auth.exchange(body));
  }

  @Post('/refresh')
  @HttpCode(200)
  async refresh(@Body() body: unknown, @Res({ passthrough: true }) response: Response): Promise<unknown> {
    return this.#audited('auth.token.refresh', response, () => this.#auth.refresh(body));
  }

  async #audited<T>(action: string, response: Response, operation: () => Promise<T>): Promise<T> {
    try {
      const result = await operation();
      await this.#audit.record({ requestId: requestId(response), action, outcome: 'succeeded', status: 200 });
      return result;
    } catch (error) {
      await this.#audit.record({ requestId: requestId(response), action, outcome: 'rejected', status: 401 });
      throw error;
    }
  }
}
