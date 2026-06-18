import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { IDEMPOTENCY_HEADER } from '../common/constants';
import { CreateTimeOffRequestDto } from './dto/create-time-off-request.dto';
import { DecisionDto } from './dto/decision.dto';
import { CancelDto } from './dto/cancel.dto';
import { ListRequestsQueryDto } from './dto/list-requests.query';
import { RequestView } from './request.view';
import { TimeOffService } from './time-off.service';

@Controller('v1/time-off-requests')
export class TimeOffController {
  constructor(private readonly timeOff: TimeOffService) {}

  /** Employee submits a time-off request. Supports an Idempotency-Key header for safe retries. */
  @Post()
  create(
    @Body() dto: CreateTimeOffRequestDto,
    @Headers(IDEMPOTENCY_HEADER) idempotencyKey?: string,
  ): Promise<RequestView> {
    return this.timeOff.create(dto, idempotencyKey?.trim() || undefined);
  }

  @Get()
  list(@Query() query: ListRequestsQueryDto): Promise<RequestView[]> {
    return this.timeOff.list(query);
  }

  @Get(':id')
  getOne(@Param('id') id: string): Promise<RequestView> {
    return this.timeOff.getById(id);
  }

  /** Manager approves — local hold stands; the HCM debit is filed asynchronously. */
  @Post(':id/approve')
  @HttpCode(200)
  approve(@Param('id') id: string, @Body() dto: DecisionDto): Promise<RequestView> {
    return this.timeOff.approve(id, dto);
  }

  /** Manager rejects — the held balance is released immediately. */
  @Post(':id/reject')
  @HttpCode(200)
  reject(@Param('id') id: string, @Body() dto: DecisionDto): Promise<RequestView> {
    return this.timeOff.reject(id, dto);
  }

  /** Cancel a pending/approved request — releasing the hold or filing a compensating refund. */
  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@Param('id') id: string, @Body() dto: CancelDto): Promise<RequestView> {
    return this.timeOff.cancel(id, dto);
  }
}
