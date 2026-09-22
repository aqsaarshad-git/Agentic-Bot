import { IsIn } from 'class-validator';

export class MarkHandledDto {
  @IsIn(['RESOLVING', 'CALL_ENDED'])
  state!: 'RESOLVING' | 'CALL_ENDED';
}
