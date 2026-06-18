import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class GetBalanceQueryDto {
  @IsOptional()
  @IsString()
  leaveType?: string;

  /** When true, pull the latest figure from the HCM realtime API (and seed it locally) first. */
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  refresh?: boolean;
}
