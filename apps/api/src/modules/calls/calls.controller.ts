import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthPrincipal } from '../../common/types/auth-principal';
import { RequestWithId } from '../../common/middleware/request-id.middleware';
import { CallsService } from './calls.service';
import { StartCallDto } from './dto/start-call.dto';
import { CallTurnDto } from './dto/call-turn.dto';

const STAFF_ROLES = ['ADMIN', 'AGENT', 'SUPERVISOR'];

@Controller('calls')
export class CallsController {
  constructor(private readonly callsService: CallsService) {}

  @Post()
  async start(@CurrentUser() actor: AuthPrincipal, @Body() dto: StartCallDto) {
    const customerId = actor.type === 'customer' ? actor.sub : dto.customerId;
    if (!customerId) {
      throw new BadRequestException('customerId is required when starting a call as staff');
    }
    const direction = dto.direction ?? (actor.type === 'customer' ? 'INBOUND' : 'OUTBOUND');
    return this.callsService.startCall(customerId, direction, dto.aiAgentId, dto.language);
  }

  @Get()
  findAll(@CurrentUser() actor: AuthPrincipal, @Query('customerId') customerId?: string) {
    if (actor.type === 'customer') {
      return this.callsService.findAll({ customerId: actor.sub });
    }
    if (!STAFF_ROLES.includes(actor.role ?? '')) {
      throw new ForbiddenException();
    }
    return this.callsService.findAll({ customerId });
  }

  @Get(':id')
  async findOne(@CurrentUser() actor: AuthPrincipal, @Param('id') id: string) {
    const call = await this.callsService.findOne(id);
    if (actor.type === 'customer' && call.customerId !== actor.sub) {
      throw new ForbiddenException();
    }
    if (actor.type === 'user' && !STAFF_ROLES.includes(actor.role ?? '')) {
      throw new ForbiddenException();
    }
    return call;
  }

  @Post(':id/turns')
  async turn(
    @CurrentUser() actor: AuthPrincipal,
    @Param('id') id: string,
    @Body() dto: CallTurnDto,
    @Req() req: RequestWithId,
  ) {
    await this.assertAccess(actor, id);
    const audio = Buffer.from(dto.audioBase64, 'base64');
    return this.callsService.handleTurn(id, audio, req.requestId);
  }

  @Post(':id/interrupt')
  async interrupt(@CurrentUser() actor: AuthPrincipal, @Param('id') id: string, @Req() req: RequestWithId) {
    await this.assertAccess(actor, id);
    return this.callsService.interrupt(id, req.requestId);
  }

  @Post(':id/end')
  async end(@CurrentUser() actor: AuthPrincipal, @Param('id') id: string) {
    await this.assertAccess(actor, id);
    // A manual hang-up means nobody is listening anymore — unlike the AI's own end_call path
    // (CallsService.handleTurn), which must NOT abort its own still-streaming goodbye message.
    return this.callsService.endCall(id, { abortAudio: true });
  }

  private async assertAccess(actor: AuthPrincipal, callId: string): Promise<void> {
    const call = await this.callsService.findOne(callId);
    if (actor.type === 'customer' && call.customerId !== actor.sub) {
      throw new ForbiddenException();
    }
    if (actor.type === 'user' && !STAFF_ROLES.includes(actor.role ?? '')) {
      throw new ForbiddenException();
    }
  }
}
