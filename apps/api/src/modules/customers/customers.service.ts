import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';

@Injectable()
export class CustomersService {
  constructor(private readonly prisma: PrismaService) {}

  create(dto: CreateCustomerDto) {
    return this.prisma.customer.create({ data: dto });
  }

  findAll(params: { take?: number; skip?: number; search?: string }) {
    const { take = 50, skip = 0, search } = params;
    return this.prisma.customer.findMany({
      // MySQL's default collation (utf8mb4_*_ci) is already case-insensitive, so no `mode` filter is needed here
      // (unlike Postgres/MongoDB, the MySQL connector doesn't support Prisma's `mode: 'insensitive'` option).
      where: search
        ? {
            OR: [
              { fullName: { contains: search } },
              { email: { contains: search } },
              { phone: { contains: search } },
            ],
          }
        : undefined,
      orderBy: { createdAt: 'desc' },
      take,
      skip,
    });
  }

  async findOne(id: string) {
    const customer = await this.prisma.customer.findUnique({ where: { id } });
    if (!customer) {
      throw new NotFoundException(`Customer ${id} not found`);
    }
    return customer;
  }

  async update(id: string, dto: UpdateCustomerDto) {
    await this.findOne(id);
    return this.prisma.customer.update({ where: { id }, data: dto });
  }

  async history(id: string) {
    await this.findOne(id);
    const [conversations, tickets, calls] = await Promise.all([
      this.prisma.conversation.findMany({
        where: { customerId: id },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      this.prisma.ticket.findMany({ where: { customerId: id }, orderBy: { createdAt: 'desc' }, take: 20 }),
      this.prisma.call.findMany({ where: { customerId: id }, orderBy: { createdAt: 'desc' }, take: 20 }),
    ]);
    return { conversations, tickets, calls };
  }
}
