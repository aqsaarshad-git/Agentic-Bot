import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

export interface CreateCallbackInput {
  customerId: string;
  conversationId?: string;
  requestedDate: Date;
  requestedTime: string;
  reason?: string;
}

@Injectable()
export class CallbacksService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Idempotent by (customerId, requestedDate, requestedTime): a retried tool call or a customer
   * asking twice for the same slot returns the existing request instead of piling up duplicate
   * PENDING rows the scheduler would otherwise dial out separately.
   */
  async create(input: CreateCallbackInput) {
    const existing = await this.prisma.callback.findFirst({
      where: {
        customerId: input.customerId,
        requestedDate: input.requestedDate,
        requestedTime: input.requestedTime,
        status: { in: ['PENDING', 'SCHEDULED'] },
      },
    });
    if (existing) return existing;
    return this.prisma.callback.create({ data: { ...input, status: 'PENDING' } });
  }

  findAll(params: { customerId?: string; take?: number; skip?: number }) {
    const { customerId, take = 50, skip = 0 } = params;
    return this.prisma.callback.findMany({
      where: { customerId },
      orderBy: { createdAt: 'desc' },
      take,
      skip,
      include: { customer: { select: { id: true, fullName: true } } },
    });
  }

  /** Ownership-checked lookup — the tool layer's only entry point for a customer session. */
  async findOneForCustomer(id: string, customerId: string) {
    const callback = await this.prisma.callback.findUnique({ where: { id } });
    if (!callback || callback.customerId !== customerId) {
      throw new NotFoundException(`Callback ${id} not found`);
    }
    return callback;
  }

  findMostRecentActiveForCustomer(customerId: string) {
    return this.prisma.callback.findFirst({
      where: { customerId, status: { in: ['PENDING', 'SCHEDULED'] } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async cancel(id: string) {
    const existing = await this.prisma.callback.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Callback ${id} not found`);
    return this.prisma.callback.update({ where: { id }, data: { status: 'CANCELLED' } });
  }

  /** Customer-facing cancel — ownership-checked, and only while there's still something to cancel. */
  async cancelForCustomer(id: string, customerId: string) {
    const existing = await this.findOneForCustomer(id, customerId);
    if (existing.status !== 'PENDING' && existing.status !== 'SCHEDULED') {
      throw new NotFoundException('This callback is no longer active');
    }
    return this.prisma.callback.update({ where: { id }, data: { status: 'CANCELLED' } });
  }
}
