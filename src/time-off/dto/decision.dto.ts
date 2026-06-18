import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** Body for manager approve / reject actions. */
export class DecisionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  approverId: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
