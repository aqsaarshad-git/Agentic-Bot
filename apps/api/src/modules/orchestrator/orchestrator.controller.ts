import { Body, Controller, ForbiddenException, Param, Post, Req } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthPrincipal } from '../../common/types/auth-principal';
import { RequestWithId } from '../../common/middleware/request-id.middleware';
import { ConversationsService } from '../conversations/conversations.service';
import { ChatGateway } from './chat.gateway';
import { OrchestratorService } from './orchestrator.service';
import { SendMessageDto } from './dto/send-message.dto';

const STAFF_ROLES = ['ADMIN', 'AGENT', 'SUPERVISOR'];

@Controller('conversations')
export class OrchestratorController {
  constructor(
    private readonly orchestratorService: OrchestratorService,
    private readonly conversationsService: ConversationsService,
    private readonly chatGateway: ChatGateway,
  ) {}

  @Post(':id/messages')
  async sendMessage(
    @CurrentUser() actor: AuthPrincipal,
    @Param('id') conversationId: string,
    @Body() dto: SendMessageDto,
    @Req() req: RequestWithId,
  ) {
    const conversation = await this.conversationsService.findOne(conversationId);
    if (actor.type === 'customer' && conversation.customerId !== actor.sub) {
      throw new ForbiddenException();
    }
    if (actor.type === 'user' && !STAFF_ROLES.includes(actor.role ?? '')) {
      throw new ForbiddenException();
    }

    // Broadcast the customer's own message immediately — real inference (the orchestrator
    // call below) can take 10-20s+, and there's no reason to make every viewer of this
    // conversation (including the sender's own chat window) wait that long just to see the
    // message they already sent land on screen.
    this.chatGateway.broadcast(conversationId, 'message', {
      sender: 'CUSTOMER',
      content: dto.content,
    });

    const result = await this.orchestratorService.handleIncomingMessage({
      conversationId,
      customerId: conversation.customerId,
      content: dto.content,
      requestId: req.requestId,
      actor,
    });

    this.chatGateway.broadcast(conversationId, 'message', {
      sender: 'AI',
      content: result.reply,
      emotion: result.emotion,
      sentiment: result.sentiment,
      urgency: result.urgency,
    });
    this.chatGateway.broadcast(conversationId, 'state', { state: result.state });

    return result;
  }
}
