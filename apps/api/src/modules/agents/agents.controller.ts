import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { Audit } from '../../common/decorators/audit.decorator';
import { AgentsService } from './agents.service';
import { CreateAgentDto } from './dto/create-agent.dto';
import { UpdateAgentDto } from './dto/update-agent.dto';

@Controller('agents')
@UseGuards(RolesGuard)
export class AgentsController {
  constructor(private readonly agentsService: AgentsService) {}

  @Post()
  @Roles('ADMIN')
  @UseGuards(PermissionsGuard)
  @RequirePermission('manage_agents')
  @Audit('agent.create')
  create(@Body() dto: CreateAgentDto) {
    return this.agentsService.create(dto);
  }

  @Get()
  @Roles('ADMIN', 'AGENT', 'SUPERVISOR')
  findAll() {
    return this.agentsService.findAll();
  }

  @Get(':id')
  @Roles('ADMIN', 'AGENT', 'SUPERVISOR')
  findOne(@Param('id') id: string) {
    return this.agentsService.findOne(id);
  }

  @Patch(':id')
  @Roles('ADMIN')
  @UseGuards(PermissionsGuard)
  @RequirePermission('manage_agents')
  @Audit('agent.update')
  update(@Param('id') id: string, @Body() dto: UpdateAgentDto) {
    return this.agentsService.update(id, dto);
  }
}
