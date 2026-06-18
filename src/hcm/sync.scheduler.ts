import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { AppConfig } from '../config/configuration';
import { ReconciliationService } from './reconciliation/reconciliation.service';
import { OutboxProcessor } from './outbox/outbox.processor';

/**
 * Wires the background jobs:
 *  - the outbox processor runs every `OUTBOX_POLL_INTERVAL_MS` to deliver pending HCM filings;
 *  - reconciliation pulls the HCM batch corpus on the `RECONCILE_CRON` schedule.
 *
 * Both are disabled when `DISABLE_SCHEDULERS=true`, which the test-suite uses to drive these
 * actions deterministically through the HTTP endpoints instead.
 */
@Injectable()
export class SyncScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SyncScheduler.name);
  private readonly disabled: boolean;
  private readonly pollIntervalMs: number;
  private readonly cron: string;

  constructor(
    private readonly processor: OutboxProcessor,
    private readonly reconciliation: ReconciliationService,
    private readonly schedulerRegistry: SchedulerRegistry,
    config: ConfigService<AppConfig, true>,
  ) {
    this.disabled = config.get('disableSchedulers', { infer: true });
    this.pollIntervalMs = config.get('outbox', { infer: true }).pollIntervalMs;
    this.cron = config.get('reconcile', { infer: true }).cron;
  }

  onModuleInit(): void {
    if (this.disabled) {
      this.logger.log('Schedulers disabled (DISABLE_SCHEDULERS=true)');
      return;
    }

    const interval = setInterval(() => void this.runOutbox(), this.pollIntervalMs);
    interval.unref(); // don't let the poll timer keep the process alive on its own
    this.schedulerRegistry.addInterval('outbox-poll', interval);
    this.logger.log(`Outbox processor scheduled every ${this.pollIntervalMs}ms`);

    try {
      const job = CronJob.from({ cronTime: this.cron, onTick: () => void this.runReconcile() });
      this.schedulerRegistry.addCronJob('hcm-reconcile', job as unknown as CronJob);
      job.start();
      this.logger.log(`HCM reconciliation scheduled with cron "${this.cron}"`);
    } catch (err) {
      this.logger.warn(`Could not schedule reconciliation cron "${this.cron}": ${err}`);
    }
  }

  onModuleDestroy(): void {
    this.safe(() => this.schedulerRegistry.deleteInterval('outbox-poll'));
    this.safe(() => {
      const job = this.schedulerRegistry.getCronJob('hcm-reconcile');
      job.stop();
      this.schedulerRegistry.deleteCronJob('hcm-reconcile');
    });
  }

  private async runOutbox(): Promise<void> {
    try {
      const summary = await this.processor.processBatch();
      if (summary.claimed > 0) {
        this.logger.debug(`Outbox tick: ${JSON.stringify(summary)}`);
      }
    } catch (err) {
      this.logger.error(`Outbox processing failed: ${err}`);
    }
  }

  private async runReconcile(): Promise<void> {
    try {
      const summary = await this.reconciliation.pullAndReconcile();
      this.logger.debug(`Reconcile tick: ${JSON.stringify(summary)}`);
    } catch (err) {
      // The HCM being unreachable is expected occasionally; do not crash the scheduler.
      this.logger.warn(`Reconciliation failed (will retry next tick): ${err}`);
    }
  }

  private safe(fn: () => void): void {
    try {
      fn();
    } catch {
      /* job/interval may not be registered (disabled mode) — ignore */
    }
  }
}
