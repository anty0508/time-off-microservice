import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class CreateTimeOffRequestDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  employeeId: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  locationId: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  leaveType?: string;

  @IsString()
  @Matches(ISO_DATE, { message: 'startDate must be in YYYY-MM-DD format' })
  startDate: string;

  @IsString()
  @Matches(ISO_DATE, { message: 'endDate must be in YYYY-MM-DD format' })
  endDate: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
