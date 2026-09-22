import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Audit } from '../../common/decorators/audit.decorator';
import { KnowledgeService } from './knowledge.service';
import { CreateKnowledgeDocumentDto } from './dto/create-knowledge-document.dto';
import { UpdateKnowledgeDocumentDto } from './dto/update-knowledge-document.dto';

@Controller('knowledge-documents')
@UseGuards(RolesGuard)
@Roles('ADMIN', 'AGENT', 'SUPERVISOR')
export class KnowledgeController {
  constructor(private readonly knowledgeService: KnowledgeService) {}

  @Post()
  @Roles('ADMIN')
  @Audit('knowledge.create')
  create(@Body() dto: CreateKnowledgeDocumentDto) {
    return this.knowledgeService.create(dto);
  }

  @Get()
  findAll() {
    return this.knowledgeService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.knowledgeService.findOne(id);
  }

  @Patch(':id')
  @Roles('ADMIN')
  @Audit('knowledge.update')
  update(@Param('id') id: string, @Body() dto: UpdateKnowledgeDocumentDto) {
    return this.knowledgeService.update(id, dto);
  }
}
