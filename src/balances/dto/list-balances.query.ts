import { IsOptional, IsString } from 'class-validator';

export class ListBalancesQueryDto {
  @IsOptional()
  @IsString()
  employeeId?: string;

  @IsOptional()
  @IsString()
  locationId?: string;

  @IsOptional()
  @IsString()
  leaveType?: string;
}
