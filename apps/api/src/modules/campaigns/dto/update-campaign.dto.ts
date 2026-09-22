import { IsIn, IsOptional, IsString } from 'class-validator';

export class UpdateCampaignDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsIn(['DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED'])
  status?: 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'COMPLETED';

  @IsOptional()
  @IsString()
  script?: string;
}
