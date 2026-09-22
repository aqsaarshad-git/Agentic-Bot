import { IsIn, IsOptional, IsString } from 'class-validator';

export class CreateKnowledgeDocumentDto {
  @IsString()
  title!: string;

  @IsOptional()
  @IsString()
  category?: string;

  @IsString()
  content!: string;

  @IsOptional()
  @IsIn(['DRAFT', 'PUBLISHED', 'ARCHIVED'])
  status?: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
}
