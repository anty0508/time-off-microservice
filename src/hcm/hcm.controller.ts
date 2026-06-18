import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { toDimensions } from '../common/dimensions';
import { OutboxStatus } from '../common/enums';
import { HcmOutbox } from '../database/entities';
import { HcmWebhookDto } from './dto/hcm-webhook.dto';
import { OutboxProcessor, ProcessSummary } from './outbox/outbox.processor';
import { OutboxService } from './outbox/outbox.service';
import { ReconciliationService, ReconcileSummary } from './reconciliation/reconciliation.service';

/**
 * Operational endpoints for HCM synchronization:
 *  - pull the batch corpus and reconcile,
 *  - receive a balance push (webhook),
 *  - drive the outbox processor on demand,
 *  - inspect outbox state.
 *
 * These also back the scheduled jobs; exposing them as endpoints makes the system observable and
 * deterministically testable.
 */
@Controller('v1/hcm')
export class HcmController {
  constructor(
    private readonly reconciliation: ReconciliationService,
    private readonly processor: OutboxProcessor,
    private readonly outbox: OutboxService,
  ) {}

  /** Pull the whole corpus from the HCM batch endpoint and reconcile every bucket. */
  @Post('sync')
  @HttpCode(200)
  sync(): Promise<ReconcileSummary> {
    return this.reconciliation.pullAndReconcile();
  }

  /** Receive a balance push from the HCM (realtime update or batch corpus). */
  @Post('webhook/balances')
  @HttpCode(200)
  webhook(@Body() dto: HcmWebhookDto): Promise<ReconcileSummary> {
    const generatedAt = dto.generatedAt ? new Date(dto.generatedAt) : new Date();
    const snapshots = dto.balances.map((b) => ({
      ...toDimensions(b),
      balanceDays: b.balanceDays,
    }));
    return this.reconciliation.ingest(snapshots, generatedAt);
  }

  /** Drive the outbox processor on demand. `?force=true` ignores the retry back-off schedule. */
  @Post('outbox/process')
  @HttpCode(200)
  process(@Query('force') force?: string): Promise<ProcessSummary> {
    return this.processor.processBatch({ force: force === 'true' || force === '1' });
  }

  /** Inspect outbox items, optionally filtered by status. */
  @Get('outbox')
  listOutbox(@Query('status') status?: OutboxStatus): Promise<HcmOutbox[]> {
    return this.outbox.list({ status });
  }
}
