import { Body, Controller, ForbiddenException, Post } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthPrincipal } from '../../common/types/auth-principal';
import { PstnCallService } from './pstn-call.service';
import { DialOutDto } from './dto/dial-out.dto';

const STAFF_ROLES = ['ADMIN', 'AGENT', 'SUPERVISOR'];

@Controller('calls')
export class TelephonyController {
  constructor(private readonly pstnCallService: PstnCallService) {}

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
}
