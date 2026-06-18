import { IsEnum, IsOptional, IsString } from 'class-validator';
import { RequestStatus } from '../../common/enums';

export class ListRequestsQueryDto {
  @IsOptional()
  @IsString()
  employeeId?: string;

  @IsOptional()
  @IsString()
  locationId?: string;

  @IsOptional()
  @IsString()
  leaveType?: string;

  @IsOptional()
  @IsEnum(RequestStatus)
  status?: RequestStatus;
}
