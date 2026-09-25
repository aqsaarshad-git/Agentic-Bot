import { BadRequestException, Body, Controller, ForbiddenException, NotFoundException, Post } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthPrincipal } from '../../common/types/auth-principal';
import { PrismaService } from '../../database/prisma.service';
import { PstnCallService } from './pstn-call.service';
import { DialOutDto } from './dto/dial-out.dto';

const STAFF_ROLES = ['ADMIN', 'AGENT', 'SUPERVISOR'];

@Controller('calls')
export class TelephonyController {
  constructor(
    private readonly pstnCallService: PstnCallService,
    private readonly prisma: PrismaService,
  ) {}

  /** Manually place a real outbound PSTN call — for testing the FreeSWITCH/Connectel path
   *  directly, outside the campaign scheduler. Staff-only, same access rule as the rest of
   *  the calls surface (see CallsController). */
  @Post('dial-out')
  dialOut(@CurrentUser() actor: AuthPrincipal, @Body() dto: DialOutDto) {
    if (actor.type !== 'user' || !STAFF_ROLES.includes(actor.role ?? '')) {
      throw new ForbiddenException();
    }
    return this.pstnCallService.dial({
      customerId: dto.customerId,
      phoneNumber: dto.phoneNumber,
      aiAgentId: dto.aiAgentId,
    });
  }

  /**
   * Self-service real-call trigger for the customer-facing banking page — reuses the exact same
   * PstnCallService.dial() the admin Customers page's "Call" button already uses; no separate
   * telephony path. Deliberately takes NO body: customerId and phoneNumber are ALWAYS resolved
   * from the authenticated customer's own JWT/DB record, never from client input — the same
   * "identity is backend-owned" rule enforced everywhere else in this project (see
   * ConversationsController.create for the identical actor.sub pattern). A customer can only ever
   * dial themselves this way.
   */
  @Post('dial-me')
  async dialMe(@CurrentUser() actor: AuthPrincipal) {
    if (actor.type !== 'customer') {
      throw new ForbiddenException();
    }
    const customer = await this.prisma.customer.findUnique({ where: { id: actor.sub }, select: { phone: true } });
    if (!customer) {
      throw new NotFoundException('Customer not found');
    }
    if (!customer.phone) {
      throw new BadRequestException('No phone number on file — a real call cannot be placed for this account yet');
    }
    return this.pstnCallService.dial({ customerId: actor.sub, phoneNumber: customer.phone });
  }
}
