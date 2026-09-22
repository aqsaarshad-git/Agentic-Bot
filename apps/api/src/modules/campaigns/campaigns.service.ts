import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { CreateCampaignDto } from './dto/create-campaign.dto';
import { UpdateCampaignDto } from './dto/update-campaign.dto';

@Injectable()
export class CampaignsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateCampaignDto) {
    return this.prisma.campaign.create({
      data: {
        name: dto.name,
        aiAgentId: dto.aiAgentId,
        startDate: new Date(dto.startDate),
        endDate: dto.endDate ? new Date(dto.endDate) : undefined,
        startTime: dto.startTime,
        endTime: dto.endTime,
        maxAttempts: dto.maxAttempts ?? 3,
        retryIntervalMinutes: dto.retryIntervalMinutes ?? 60,
        script: dto.script,
        contacts: {
          create: dto.customerIds.map((customerId) => ({ customerId })),
        },
      },
      include: { contacts: true },
    });
  }

  findAll() {
    return this.prisma.campaign.findMany({
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { contacts: true } } },
    });
  }

  async findOne(id: string) {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id },
      include: {
        contacts: {
          include: { customer: { select: { id: true, fullName: true } }, calls: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!campaign) throw new NotFoundException(`Campaign ${id} not found`);
    return campaign;
  }

  async update(id: string, dto: UpdateCampaignDto) {
    await this.findOne(id);
    return this.prisma.campaign.update({
      where: { id },
      data: { name: dto.name, status: dto.status, script: dto.script },
    });
  }
}
