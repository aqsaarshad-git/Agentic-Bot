import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../database/prisma.service';
import { REQUIRED_PERMISSION_KEY } from '../decorators/require-permission.decorator';
import { AuthPrincipal } from '../types/auth-principal';

/**
 * Backs authorization with the actual `permissions`/`role_permissions` tables, rather
 * than a hardcoded role-name check. Used for the handful of sensitive actions where a
 * role name alone ("is this an ADMIN") isn't precise enough — e.g. toggling tools or
 * editing AI agent configuration.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredPermission = this.reflector.getAllAndOverride<string>(REQUIRED_PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!requiredPermission) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const actor: AuthPrincipal | undefined = request.user;
    if (!actor || actor.type !== 'user') {
      throw new ForbiddenException('This action requires staff permissions');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: actor.sub },
      include: { role: { include: { rolePermissions: { include: { permission: true } } } } },
    });
    const hasPermission = user?.role.rolePermissions.some((rp) => rp.permission.name === requiredPermission);
    if (!hasPermission) {
      throw new ForbiddenException(`Missing required permission: ${requiredPermission}`);
    }
    return true;
  }
}
