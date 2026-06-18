import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CancelDto {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  actorId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
