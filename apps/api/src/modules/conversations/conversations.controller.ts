import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ConversationState } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthPrincipal } from '../../common/types/auth-principal';
import { Audit } from '../../common/decorators/audit.decorator';
import { ConversationsService } from './conversations.service';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { MarkHandledDto } from './dto/mark-handled.dto';

const STAFF_ROLES = ['ADMIN', 'AGENT', 'SUPERVISOR'];

@Controller('conversations')
export class ConversationsController {
  constructor(private readonly conversationsService: ConversationsService) {}

  @Post()
  create(@CurrentUser() actor: AuthPrincipal, @Body() dto: CreateConversationDto) {
    const customerId = actor.type === 'customer' ? actor.sub : dto.customerId;
    if (!customerId) {
      throw new BadRequestException('customerId is required when starting a conversation as staff');
    }
    return this.conversationsService.create({
      customerId,
      aiAgentId: dto.aiAgentId,
      channel: dto.channel,
    });
  }

  @Get()
  findAll(
    @CurrentUser() actor: AuthPrincipal,
    @Query('customerId') customerId?: string,
    @Query('state') state?: ConversationState,
  ) {
    if (actor.type === 'customer') {
      return this.conversationsService.findAll({ customerId: actor.sub });
    }
    if (!STAFF_ROLES.includes(actor.role ?? '')) {
      throw new ForbiddenException();
    }
    return this.conversationsService.findAll({ customerId, state });
  }

  @Get(':id')
  async findOne(@CurrentUser() actor: AuthPrincipal, @Param('id') id: string) {
    const conversation = await this.conversationsService.findOne(id);
    if (actor.type === 'customer' && conversation.customerId !== actor.sub) {
      throw new ForbiddenException();
    }
    if (actor.type === 'user' && !STAFF_ROLES.includes(actor.role ?? '')) {
      throw new ForbiddenException();
    }
    return conversation;
  }

  @Patch(':id/handled')
  @Audit('conversation.marked_handled')
  markHandled(
    @CurrentUser() actor: AuthPrincipal,
    @Param('id') id: string,
    @Body() dto: MarkHandledDto,
  ) {
    if (!STAFF_ROLES.includes(actor.role ?? '')) {
      throw new ForbiddenException();
    }
    return this.conversationsService.markHandledByStaff(id, dto.state);
  }
}
