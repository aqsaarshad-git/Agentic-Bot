import { IsNumber, IsOptional, IsPositive, IsString } from 'class-validator';

export class RefundTicketDto {
  /** Defaults to the ticket's own disputeAmount if omitted. */
  @IsOptional()
  @IsNumber()
  @IsPositive()
  amount?: number;

  @IsOptional()
  @IsString()
  reason?: string;
}
