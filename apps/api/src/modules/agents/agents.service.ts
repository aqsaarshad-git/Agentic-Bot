import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { CreateAgentDto } from './dto/create-agent.dto';
import { UpdateAgentDto } from './dto/update-agent.dto';

@Injectable()
export class AgentsService {
  constructor(private readonly prisma: PrismaService) {}

  create(dto: CreateAgentDto) {
    return this.prisma.aiAgent.create({
      data: {
        name: dto.name,
        description: dto.description,
        configs: {
          create: {
            version: 1,
            systemInstructions: dto.systemInstructions,
            supportedLanguages: dto.supportedLanguages,
            allowedTools: dto.allowedTools,
            voiceConfig: dto.voiceConfig as Prisma.InputJsonValue | undefined,
            personality: dto.personality as Prisma.InputJsonValue | undefined,
            knowledgeBaseAccess: dto.knowledgeBaseAccess ?? true,
            escalationRules: dto.escalationRules as Prisma.InputJsonValue | undefined,
            businessRules: dto.businessRules as Prisma.InputJsonValue | undefined,
            workingHours: dto.workingHours as Prisma.InputJsonValue | undefined,
            isActive: true,
          },
        },
      },
      include: { configs: true },
    });
  }

  findAll() {
    return this.prisma.aiAgent.findMany({
      include: { configs: { where: { isActive: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string) {
    const agent = await this.prisma.aiAgent.findUnique({
      where: { id },
      include: { configs: { where: { isActive: true } } },
    });
    if (!agent) {
      throw new NotFoundException(`AI agent ${id} not found`);
    }
    return agent;
  }

  async getActiveConfig(id: string) {
    const agent = await this.findOne(id);
    const config = agent.configs[0];
    if (!config) {
      throw new NotFoundException(`AI agent ${id} has no active configuration`);
    }
    return { agent, config };
  }

  async update(id: string, dto: UpdateAgentDto) {
    const agent = await this.findOne(id);
    const activeConfig = agent.configs[0];

    await this.prisma.aiAgent.update({
      where: { id },
      data: {
        name: dto.name,
        description: dto.description,
        status: dto.status,
      },
    });

    if (activeConfig) {
      await this.prisma.agentConfig.update({
        where: { id: activeConfig.id },
        data: {
          systemInstructions: dto.systemInstructions,
          supportedLanguages: dto.supportedLanguages,
          allowedTools: dto.allowedTools,
          voiceConfig: dto.voiceConfig as Prisma.InputJsonValue | undefined,
          personality: dto.personality as Prisma.InputJsonValue | undefined,
          knowledgeBaseAccess: dto.knowledgeBaseAccess,
          escalationRules: dto.escalationRules as Prisma.InputJsonValue | undefined,
          businessRules: dto.businessRules as Prisma.InputJsonValue | undefined,
          workingHours: dto.workingHours as Prisma.InputJsonValue | undefined,
        },
      });
    }

    return this.findOne(id);
  }
}
