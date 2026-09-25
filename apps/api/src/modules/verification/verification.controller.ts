import { Controller, ForbiddenException, Get, Query } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthPrincipal } from '../../common/types/auth-principal';
import { PrismaService } from '../../database/prisma.service';
import { TransfersService } from '../transfers/transfers.service';
import { VerificationService } from './verification.service';

/**
 * Read-only status for the dev test panel / a future admin page — never a mutation endpoint
 * (start_verification/verify_otp stay tool-only, behind the orchestrator). Verification is
 * conversation-scoped (see VerificationService), so `conversationId` is required; identity
 * always comes from the JWT, never a supplied customerId.
 */
@Controller('verification')
export class VerificationController {
  constructor(
    private readonly verification: VerificationService,
    private readonly transfers: TransfersService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('status')
  async status(@CurrentUser() actor: AuthPrincipal, @Query('conversationId') conversationId?: string) {
    if (actor.type !== 'customer') {
      throw new ForbiddenException('Specify a customer to view verification status for');
    }
    const [status, level, customer, pendingTransfer, lastToolExecution] = await Promise.all([
      this.verification.computeStatus(actor.sub, conversationId),
      this.verification.computeLevel(actor.sub, conversationId),
      this.prisma.customer.findUnique({ where: { id: actor.sub } }),
      conversationId ? this.transfers.getActivePendingSummary(conversationId) : Promise.resolve(null),
      conversationId
        ? this.prisma.toolExecution.findFirst({
            where: { conversationId },
            orderBy: { executedAt: 'desc' },
            include: { tool: true },
          })
        : Promise.resolve(null),
    ]);
    return {
      status,
      verificationLevel: level,
      onlineBankingLocked: customer?.onlineBankingLocked ?? false,
      failedLoginAttempts: customer?.failedLoginAttempts ?? 0,
      pendingTransfer,
      lastTool: lastToolExecution
        ? { name: lastToolExecution.tool.name, status: lastToolExecution.status, executedAt: lastToolExecution.executedAt }
        : null,
    };
  }
}
