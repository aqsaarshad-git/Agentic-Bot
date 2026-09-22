import { IsBoolean } from 'class-validator';

export class SetToolEnabledDto {
  @IsBoolean()
  isEnabled!: boolean;
}
