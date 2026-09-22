import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

/**
 * Long-term memory, kept deliberately compact: aggregate counts + the most recent
 * ticket, never the customer's full history. The orchestrator injects this as one
 * extra system message rather than dumping raw records into the LLM's context.
 */
@Injectable()
export class CustomerMemoryService {
  constructor(private readonly prisma: PrismaService) {}

  async buildMemoryContext(customerId: string): Promise<string | null> {
    const [totalTickets, openTickets, recentTicket, conversationCount] = await Promise.all([
      this.prisma.ticket.count({ where: { customerId } }),
      this.prisma.ticket.count({ where: { customerId, status: { notIn: ['RESOLVED', 'CLOSED'] } } }),
      this.prisma.ticket.findFirst({ where: { customerId }, orderBy: { createdAt: 'desc' } }),
      this.prisma.conversation.count({ where: { customerId } }),
    ]);

    if (totalTickets === 0 && conversationCount <= 1) {
      return null;
    }

    const parts = [`Customer memory: ${totalTickets} prior ticket(s), ${openTickets} currently open.`];
    if (recentTicket) {
      parts.push(
        `Most recent ticket ${recentTicket.ticketNumber} (${recentTicket.category ?? 'general'}): status ${recentTicket.status}.`,
      );
    }
    return parts.join(' ');
  }
}
