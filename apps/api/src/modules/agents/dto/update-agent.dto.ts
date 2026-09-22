import { IsArray, IsBoolean, IsIn, IsOptional, IsString } from 'class-validator';

export class UpdateAgentDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsIn(['ACTIVE', 'INACTIVE'])
  status?: 'ACTIVE' | 'INACTIVE';

  @IsOptional()
  @IsString()
  systemInstructions?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  supportedLanguages?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allowedTools?: string[];

  @IsOptional()
  voiceConfig?: Record<string, unknown>;

  @IsOptional()
  personality?: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  knowledgeBaseAccess?: boolean;

  @IsOptional()
  escalationRules?: Record<string, unknown>;

  @IsOptional()
  businessRules?: Record<string, unknown>;

  @IsOptional()
  workingHours?: Record<string, unknown>;
}
