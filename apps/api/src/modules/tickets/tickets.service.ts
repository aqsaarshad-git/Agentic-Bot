import { Injectable, NotFoundException } from '@nestjs/common';
import { TicketMessageAuthorType, TicketStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { UpdateTicketDto } from './dto/update-ticket.dto';

@Injectable()
export class TicketsService {
  constructor(private readonly prisma: PrismaService) {}

  private generateTicketNumber(): string {
    const stamp = Date.now().toString(36).toUpperCase();
    const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
    return `TCK-${stamp}-${rand}`;
  }

  async create(dto: CreateTicketDto) {
    return this.prisma.ticket.create({
      data: {
        ticketNumber: this.generateTicketNumber(),
        customerId: dto.customerId,
        conversationId: dto.conversationId,
        category: dto.category,
        priority: dto.priority ?? 'MEDIUM',
        description: dto.description,
        aiSummary: dto.aiSummary,
      },
    });
  }

  findAll(params: { status?: TicketStatus; customerId?: string; take?: number; skip?: number }) {
    const { status, customerId, take = 50, skip = 0 } = params;
    return this.prisma.ticket.findMany({
      where: { status, customerId },
      orderBy: { createdAt: 'desc' },
      take,
      skip,
      include: {
        customer: true,
        assignments: {
          where: { unassignedAt: null },
          include: { user: { select: { id: true, name: true } } },
        },
      },
    });
  }

  async findOne(id: string) {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id },
      include: { customer: true, messages: { orderBy: { createdAt: 'asc' } }, assignments: true },
    });
    if (!ticket) {
      throw new NotFoundException(`Ticket ${id} not found`);
    }
    return ticket;
  }

  async findByTicketNumber(ticketNumber: string) {
    const ticket = await this.prisma.ticket.findUnique({ where: { ticketNumber } });
    if (!ticket) {
      throw new NotFoundException(`Ticket ${ticketNumber} not found`);
    }
    return ticket;
  }

  async update(id: string, dto: UpdateTicketDto) {
    const existing = await this.findOne(id);
    let status = dto.status;

    if (dto.assignToUserId) {
      await this.prisma.$transaction([
        this.prisma.ticketAssignment.updateMany({
          where: { ticketId: id, unassignedAt: null },
          data: { unassignedAt: new Date() },
        }),
        this.prisma.ticketAssignment.create({
          data: { ticketId: id, userId: dto.assignToUserId },
        }),
      ]);
      // Assigning a brand-new ticket implicitly moves it into an active state.
      if (!status && existing.status === 'NEW') {
        status = 'OPEN';
      }
    }

    return this.prisma.ticket.update({
      where: { id },
      data: {
        status,
        priority: dto.priority,
        category: dto.category,
        resolution: dto.resolution,
      },
    });
  }

  async addMessage(id: string, authorType: TicketMessageAuthorType, content: string, authorId?: string) {
    await this.findOne(id);
    return this.prisma.ticketMessage.create({
      data: { ticketId: id, authorType, authorId, content },
    });
  }

  async escalate(id: string, reason: string) {
    await this.findOne(id);
    await this.prisma.ticketMessage.create({
      data: { ticketId: id, authorType: 'SYSTEM', content: `Escalated: ${reason}` },
    });
    return this.prisma.ticket.update({ where: { id }, data: { status: 'ESCALATED' } });
  }
}
