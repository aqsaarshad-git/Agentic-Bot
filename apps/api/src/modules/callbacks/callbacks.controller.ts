import { Controller, Get, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Audit } from '../../common/decorators/audit.decorator';
import { CallbacksService } from './callbacks.service';

@Controller('callbacks')
@UseGuards(RolesGuard)
@Roles('ADMIN', 'AGENT', 'SUPERVISOR')
export class CallbacksController {
  constructor(private readonly callbacksService: CallbacksService) {}

  @Get()
  findAll(@Query('customerId') customerId?: string) {
    return this.callbacksService.findAll({ customerId });
  }

  @Patch(':id/cancel')
  @Audit('callback.cancel')
  cancel(@Param('id') id: string) {
    return this.callbacksService.cancel(id);
  }
}
