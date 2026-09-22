import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, catchError, tap, throwError } from 'rxjs';
import { AuditActorType } from '@prisma/client';
import { AUDIT_ACTION_KEY } from '../decorators/audit.decorator';
import { AuditService } from '../../modules/audit/audit.service';
import { AuthPrincipal } from '../types/auth-principal';
import { RequestWithId } from '../middleware/request-id.middleware';

@Injectable()
export class AuditLoggingInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly auditService: AuditService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const action = this.reflector.getAllAndOverride<string>(AUDIT_ACTION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!action) {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest<RequestWithId & { user?: AuthPrincipal }>();
    const actor = request.user;

    return next.handle().pipe(
      tap((result) => {
        void this.auditService.log({
          requestId: request.requestId,
          actorType: this.resolveActorType(actor),
          actorId: actor?.sub,
          action,
          result: this.safeResult(result),
          success: true,
        });
      }),
      catchError((error) => {
        void this.auditService.log({
          requestId: request.requestId,
          actorType: this.resolveActorType(actor),
          actorId: actor?.sub,
          action,
          result: { error: error instanceof Error ? error.message : String(error) },
          success: false,
        });
        return throwError(() => error);
      }),
    );
  }

  private resolveActorType(actor?: AuthPrincipal): AuditActorType {
    if (!actor) return AuditActorType.SYSTEM;
    return actor.type === 'customer' ? AuditActorType.CUSTOMER : AuditActorType.USER;
  }

  private safeResult(result: unknown): unknown {
    if (result === undefined || result === null) return undefined;
    try {
      return JSON.parse(JSON.stringify(result));
    } catch {
      return undefined;
    }
  }
}
