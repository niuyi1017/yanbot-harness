import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';

import type { CloudRequest } from '../common/request-context.js';
import { AuthService } from './auth.service.js';

@Injectable()
export class AccessTokenGuard implements CanActivate {
  readonly #auth: AuthService;

  constructor(@Inject(AuthService) auth: AuthService) {
    this.#auth = auth;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<CloudRequest>();
    request.cloudPrincipal = await this.#auth.authenticate(request.headers.authorization);
    return true;
  }
}
