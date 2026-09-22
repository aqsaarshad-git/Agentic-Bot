import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.user.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, email: true, name: true, createdAt: true, role: { select: { name: true } } },
      orderBy: { name: 'asc' },
    });
  }
}
