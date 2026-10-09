import { once } from 'node:events';
import { Body, Controller, Headers, Inject, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { authenticationFailed } from '../common/cloud-error.js';
import { requestId } from '../common/request-context.js';
import { ModelBrokerService } from './model-broker.service.js';
import type { ModelStream } from './forward.js';

@Controller('/internal/v1/runs')
export class ModelBrokerController {
  constructor(@Inject(ModelBrokerService) private readonly broker: ModelBrokerService) {}

  @Post('/:runId/model')
  async invoke(
    @Param('runId') runId: string,
    @Query('attempt') attemptValue: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-worker-id') workerId: string | undefined,
    @Body() body: unknown,
    @Res() response: Response,
  ): Promise<void> {
    const grant = /^Bearer (yhe_[A-Za-z0-9_-]{43})$/u.exec(authorization ?? '')?.[1];
    const attempt = Number(attemptValue);
    if (!grant || !Number.isSafeInteger(attempt) || attempt < 1) throw authenticationFailed();
    const abort = new AbortController();
    const disconnected = () => abort.abort();
    response.once('close', disconnected);
    let stream: ModelStream | undefined;
    try {
      stream = await this.broker.invoke({
        grant,
        runId,
        attempt,
        workerId,
        body,
        signal: abort.signal,
        requestId: requestId(response),
      });
      const signal = AbortSignal.any([abort.signal, stream.signal]);
      response
        .status(200)
        .set({ 'content-type': stream.contentType, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      for await (const chunk of stream.body) {
        signal.throwIfAborted();
        if (!response.write(chunk)) await once(response, 'drain', { signal });
      }
      response.end();
    } catch (error) {
      if (response.headersSent || response.destroyed || abort.signal.aborted) response.destroy();
      else throw error;
    } finally {
      stream?.close();
      abort.abort();
      response.off('close', disconnected);
    }
  }
}
