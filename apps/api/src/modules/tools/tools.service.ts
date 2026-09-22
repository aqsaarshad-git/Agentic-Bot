import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { ToolRegistryService } from './tool-registry.service';

@Injectable()
export class ToolsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly toolRegistry: ToolRegistryService,
  ) {}

  findAll() {
    return this.prisma.tool.findMany({ orderBy: { name: 'asc' } });
  }

  async setEnabled(id: string, isEnabled: boolean) {
    const tool = await this.prisma.tool.findUnique({ where: { id } });
    if (!tool) {
      throw new NotFoundException(`Tool ${id} not found`);
    }
    const updated = await this.prisma.tool.update({ where: { id }, data: { isEnabled } });
    this.toolRegistry.setEnabledCache(tool.name, isEnabled);
    return updated;
  }
}
