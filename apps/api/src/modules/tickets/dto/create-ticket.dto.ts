import { IsIn, IsOptional, IsString } from 'class-validator';

export class CreateTicketDto {
  @IsString()
  customerId!: string;

  @IsOptional()
  @IsString()
  conversationId?: string;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsIn(['LOW', 'MEDIUM', 'HIGH', 'URGENT'])
  priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';

  @IsString()
  description!: string;

  @IsOptional()
  @IsString()
  aiSummary?: string;
}
