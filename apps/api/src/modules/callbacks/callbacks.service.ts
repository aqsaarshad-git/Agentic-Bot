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

  create(input: CreateCallbackInput) {
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

  async cancel(id: string) {
    const existing = await this.prisma.callback.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Callback ${id} not found`);
    return this.prisma.callback.update({ where: { id }, data: { status: 'CANCELLED' } });
  }
}
