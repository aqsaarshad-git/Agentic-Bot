import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AuthPrincipal } from '../types/auth-principal';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthPrincipal => {
    const request = ctx.switchToHttp().getRequest();
    return request.user;
  },
);
