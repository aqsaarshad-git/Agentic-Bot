import { IsString } from 'class-validator';

export class InboundAnswerDto {
  @IsString()
  fromNumber!: string;

  @IsString()
  toNumber!: string;

  @IsString()
  providerCallUuid!: string;
}
