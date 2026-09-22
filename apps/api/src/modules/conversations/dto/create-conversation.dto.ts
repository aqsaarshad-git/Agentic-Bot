import { IsIn, IsOptional, IsString } from 'class-validator';

export class CreateConversationDto {
  @IsOptional()
  @IsString()
  customerId?: string;

  @IsOptional()
  @IsString()
  aiAgentId?: string;

  @IsOptional()
  @IsIn(['TEXT', 'VOICE'])
  channel?: 'TEXT' | 'VOICE';
}
