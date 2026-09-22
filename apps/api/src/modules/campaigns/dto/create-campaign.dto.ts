import { ArrayMinSize, IsArray, IsDateString, IsInt, IsOptional, IsString, Matches, Min } from 'class-validator';

export class CreateCampaignDto {
  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  aiAgentId?: string;

  @IsDateString()
  startDate!: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'startTime must be HH:mm' })
  startTime?: string;

  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'endTime must be HH:mm' })
  endTime?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxAttempts?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  retryIntervalMinutes?: number;

  @IsOptional()
  @IsString()
  script?: string;

  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  customerIds!: string[];
}
