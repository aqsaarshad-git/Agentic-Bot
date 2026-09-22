import { IsArray, IsBoolean, IsOptional, IsString } from 'class-validator';

export class CreateAgentDto {
  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsString()
  systemInstructions!: string;

  @IsArray()
  @IsString({ each: true })
  supportedLanguages!: string[];

  @IsArray()
  @IsString({ each: true })
  allowedTools!: string[];

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
