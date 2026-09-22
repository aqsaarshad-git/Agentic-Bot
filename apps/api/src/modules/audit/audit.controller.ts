import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuditActorType } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AuditService } from './audit.service';

@Controller('audit-logs')
@UseGuards(RolesGuard)
@Roles('ADMIN', 'SUPERVISOR')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get()
  findMany(
    @Query('entityType') entityType?: string,
    @Query('entityId') entityId?: string,
    @Query('actorType') actorType?: AuditActorType,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    return this.auditService.findMany({
      entityType,
      entityId,
      actorType,
      take: take ? Number(take) : undefined,
      skip: skip ? Number(skip) : undefined,
    });
  }
}
