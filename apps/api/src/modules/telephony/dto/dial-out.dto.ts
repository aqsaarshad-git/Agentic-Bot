import { IsOptional, IsString } from 'class-validator';

export class DialOutDto {
  @IsString()
  customerId!: string;

  @IsString()
  phoneNumber!: string;

  @IsOptional()
  @IsString()
  aiAgentId?: string;
}
