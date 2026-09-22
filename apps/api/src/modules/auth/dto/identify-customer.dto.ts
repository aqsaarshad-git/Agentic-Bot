import { IsEmail, IsOptional, IsString } from 'class-validator';

export class IdentifyCustomerDto {
  @IsString()
  fullName!: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  language?: string;
}
