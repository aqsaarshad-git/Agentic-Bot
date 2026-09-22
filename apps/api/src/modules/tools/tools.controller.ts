import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { Audit } from '../../common/decorators/audit.decorator';
import { ToolsService } from './tools.service';
import { SetToolEnabledDto } from './dto/set-tool-enabled.dto';

@Controller('tools')
@UseGuards(RolesGuard)
@Roles('ADMIN', 'SUPERVISOR')
export class ToolsController {
  constructor(private readonly toolsService: ToolsService) {}

  @Get()
  findAll() {
    return this.toolsService.findAll();
  }

  @Patch(':id')
  @Roles('ADMIN')
  @UseGuards(PermissionsGuard)
  @RequirePermission('manage_tools')
  @Audit('tool.toggle')
  setEnabled(@Param('id') id: string, @Body() dto: SetToolEnabledDto) {
    return this.toolsService.setEnabled(id, dto.isEnabled);
  }
}
