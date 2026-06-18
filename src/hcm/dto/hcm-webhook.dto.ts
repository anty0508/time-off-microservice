import { Type } from 'class-transformer';
import {
  IsArray,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class HcmSnapshotDto {
  @IsString()
  @MinLength(1)
  employeeId: string;

  @IsString()
  @MinLength(1)
  locationId: string;

  @IsOptional()
  @IsString()
  leaveType?: string;

  @IsNumber()
  balanceDays: number;
}

/**
 * Payload the HCM pushes to ExampleHR — either the whole corpus (batch) or one/few realtime
 * updates (e.g. "1 day for locationId X employeeId Y"). `generatedAt` is the snapshot time.
 */
export class HcmWebhookDto {
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}T.+/, { message: 'generatedAt must be an ISO-8601 timestamp' })
  generatedAt?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => HcmSnapshotDto)
  balances: HcmSnapshotDto[];
}
