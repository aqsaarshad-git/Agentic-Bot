import { IsString } from 'class-validator';

export class WorkerTurnDto {
  @IsString()
  audioBase64!: string;
}
