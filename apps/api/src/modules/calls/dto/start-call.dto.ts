import { IsIn, IsOptional, IsString } from 'class-validator';

export class StartCallDto {
  @IsOptional()
  @IsString()
  customerId?: string;

  @IsOptional()
  @IsString()
  aiAgentId?: string;

  @IsOptional()
  @IsIn(['INBOUND', 'OUTBOUND'])
  direction?: 'INBOUND' | 'OUTBOUND';

  // Which language the customer will actually speak on THIS call — the STT provider only
  // supports "ar"|"en" and has no auto-detect, so without this it silently guesses (see
  // CallsService.startCall for the default when omitted).
  @IsOptional()
  @IsIn(['ar', 'en'])
  language?: 'ar' | 'en';
}
