import { Injectable, NotFoundException } from '@nestjs/common';
import { ConversationState, MessageSender, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

export interface CreateConversationInput {
  customerId: string;
  aiAgentId?: string;
  channel?: 'TEXT' | 'VOICE';
}

@Injectable()
export class ConversationsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: CreateConversationInput) {
    let aiAgentId = input.aiAgentId;
    if (!aiAgentId) {
      const defaultAgent = await this.prisma.aiAgent.findFirst({
        where: { status: 'ACTIVE' },
        orderBy: { createdAt: 'asc' },
      });
      aiAgentId = defaultAgent?.id;
    }

    return this.prisma.conversation.create({
      data: {
        customerId: input.customerId,
        aiAgentId,
        channel: input.channel ?? 'TEXT',
        state: 'CALL_STARTED',
      },
    });
  }

  findAll(params: { customerId?: string; state?: ConversationState; take?: number; skip?: number }) {
    const { customerId, state, take = 50, skip = 0 } = params;
    return this.prisma.conversation.findMany({
      where: { customerId, state },
      orderBy: { createdAt: 'desc' },
      take,
      skip,
      include: {
        customer: { select: { id: true, fullName: true } },
        summaries: { orderBy: { generatedAt: 'desc' }, take: 1 },
      },
    });
  }

  async findOne(id: string) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id },
      include: { messages: { orderBy: { createdAt: 'asc' } }, customer: true, aiAgent: true },
    });
    if (!conversation) {
      throw new NotFoundException(`Conversation ${id} not found`);
    }
    return conversation;
  }

  async addMessage(
    conversationId: string,
    sender: MessageSender,
    content: string,
    toolCalls?: unknown,
  ) {
    return this.prisma.message.create({
      data: {
        conversationId,
        sender,
        content,
        toolCalls: toolCalls as Prisma.InputJsonValue | undefined,
      },
    });
  }

  async updateState(id: string, state: ConversationState) {
    return this.prisma.conversation.update({
      where: { id },
      data: {
        state,
        endedAt: state === 'CALL_ENDED' ? new Date() : undefined,
      },
    });
  }

  async setIntent(id: string, intent: string) {
    return this.prisma.conversation.update({ where: { id }, data: { intent } });
  }

  async saveSummary(conversationId: string, summary: string) {
    return this.prisma.conversationSummary.create({ data: { conversationId, summary } });
  }

  /** Manual staff-driven transition out of an escalation queue (as opposed to orchestrator-driven transitions). */
  async markHandledByStaff(id: string, state: Extract<ConversationState, 'RESOLVING' | 'CALL_ENDED'>) {
    await this.findOne(id);
    return this.updateState(id, state);
  }
}
