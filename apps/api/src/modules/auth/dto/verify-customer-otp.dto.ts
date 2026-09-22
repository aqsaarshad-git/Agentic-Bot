import { IsString, Length } from 'class-validator';

export class VerifyCustomerOtpDto {
  @IsString()
  customerId!: string;

  @IsString()
  @Length(6, 6)
  code!: string;
}
