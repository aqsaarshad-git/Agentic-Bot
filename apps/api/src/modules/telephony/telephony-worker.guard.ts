import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';

/**
 * Authenticates requests from the telephony worker (telephony-worker/worker.js, running on the
 * FreeSWITCH box) against apps/api/src/modules/telephony/telephony-worker.controller.ts — a
 * shared secret (TELEPHONY_WORKER_SECRET), not a customer/staff JWT, since the worker isn't
 * either of those. Routes using this guard are also marked @Public() to skip the global
 * JwtAuthGuard entirely (see app.module.ts) rather than trying to satisfy both.
 */
@Injectable()
export class TelephonyWorkerGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const expected = this.config.get<string>('telephony.workerSecret');
    const provided = request.headers['x-telephony-worker-secret'];
    if (!expected || provided !== expected) {
      throw new UnauthorizedException('Invalid or missing telephony worker secret');
    }
    return true;
  }
}
