import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EntityManager } from 'typeorm';
import { BalancesService } from '../../balances/balances.service';
import { AppConfig } from '../../config/configuration';
import { toDimensions } from '../../common/dimensions';
import {
  HcmFilingStatus,
  LedgerEntryType,
  LedgerSource,
  OutboxOperation,
  RequestStatus,
} from '../../common/enums';
import { TransactionRunner } from '../../database/transaction.runner';
import { HcmOutbox, TimeOffRequest } from '../../database/entities';
import { HcmBusinessError, HcmTransientError } from '../hcm.types';
import { HcmClient } from '../hcm.client';
import { ReconciliationService } from '../reconciliation/reconciliation.service';
import { OutboxService } from './outbox.service';

export interface ProcessSummary {
  claimed: number;
  sent: number;
  failed: number;
  retried: number;
  skipped: number;
}

/**
 * Delivers outbox items to the HCM realtime API and applies the outcome:
 *  - success            -> convert hold to confirmed debit / apply confirmed credit
 *  - business refusal    -> release hold, mark request FAILED, trigger a single-bucket reconcile
 *  - transient failure   -> exponential back-off retry (until DEAD)
 *
 * The HCM call happens OUTSIDE the DB transaction; only the local state application is transactional
 * and idempotent (it re-checks the outbox item is still active before applying).
 */
@Injectable()
export class OutboxProcessor {
  private readonly logger = new Logger(OutboxProcessor.name);
  private readonly batchSize: number;
  private running = false;

  constructor(
    private readonly outbox: OutboxService,
    private readonly balances: BalancesService,
    private readonly hcm: HcmClient,
    private readonly reconciliation: ReconciliationService,
    private readonly tx: TransactionRunner,
    config: ConfigService<AppConfig, true>,
  ) {
    this.batchSize = config.get('outbox', { infer: true }).batchSize;
  }

  /** Process all currently-due outbox items. `force` ignores the retry back-off schedule. */
  async processBatch(opts: { limit?: number; force?: boolean } = {}): Promise<ProcessSummary> {
    const summary: ProcessSummary = { claimed: 0, sent: 0, failed: 0, retried: 0, skipped: 0 };
    // Guard against overlapping scheduler ticks.
    if (this.running) return summary;
    this.running = true;
    try {
      const due = await this.outbox.claimDue(opts.limit ?? this.batchSize, opts.force ?? false);
      summary.claimed = due.length;
      for (const item of due) {
        const outcome = await this.processItem(item);
        summary[outcome] += 1;
      }
      return summary;
    } finally {
      this.running = false;
    }
  }

  private async processItem(item: HcmOutbox): Promise<'sent' | 'failed' | 'retried' | 'skipped'> {
    const dims = toDimensions(item);
    try {
      const result = await this.hcm.fileTimeOff({
        dims,
        deltaDays: item.deltaDays,
        requestId: item.requestId,
        idempotencyKey: item.idempotencyKey,
      });
      const applied = await this.applySuccess(item, result.reference);
      return applied ? 'sent' : 'skipped';
    } catch (err) {
      if (err instanceof HcmBusinessError) {
        await this.applyBusinessFailure(item, err);
        // The refusal means our local view drifted from the HCM; repair it.
        await this.safeReconcile(item);
        return 'failed';
      }
      if (err instanceof HcmTransientError) {
        await this.tx.run(async (m) => {
          const fresh = await this.outbox.loadActive(m, item.id);
          if (fresh) await this.outbox.scheduleRetry(m, fresh, err.message);
        });
        return 'retried';
      }
      throw err;
    }
  }

  private async applySuccess(item: HcmOutbox, reference: string): Promise<boolean> {
    return this.tx.run(async (manager) => {
      const fresh = await this.outbox.loadActive(manager, item.id);
      if (!fresh) return false; // already applied or cancelled — idempotent no-op
      await this.outbox.markSent(manager, fresh, reference);

      const request = await this.loadRequest(manager, fresh.requestId);
      const dims = toDimensions(fresh);
      const days = Math.abs(fresh.deltaDays);

      if (fresh.operation === OutboxOperation.FILE_DEBIT) {
        await this.balances.confirmDebit(manager, dims, days, request.id, { reference });
        request.hcmFilingStatus = HcmFilingStatus.CONFIRMED;
        request.hcmReference = reference;
        request.hcmConfirmedAt = new Date();
      } else {
        // FILE_CREDIT (refund). Tagged HCM_REALTIME so reconciliation accounts for it correctly.
        await this.balances.credit(
          manager,
          dims,
          days,
          request.id,
          LedgerSource.HCM_REALTIME,
          LedgerEntryType.CREDIT,
          { reference },
        );
        request.hcmFilingStatus = HcmFilingStatus.CONFIRMED;
        request.hcmReference = reference;
        request.hcmConfirmedAt = new Date();
      }
      await manager.save(request);
      return true;
    });
  }

  private async applyBusinessFailure(item: HcmOutbox, err: HcmBusinessError): Promise<void> {
    await this.tx.run(async (manager) => {
      const fresh = await this.outbox.loadActive(manager, item.id);
      if (!fresh) return;
      await this.outbox.markFailed(manager, fresh, `${err.code}: ${err.message}`);

      const request = await this.loadRequest(manager, fresh.requestId);
      const dims = toDimensions(fresh);
      const days = Math.abs(fresh.deltaDays);

      if (fresh.operation === OutboxOperation.FILE_DEBIT) {
        // The HCM refused the debit — release the local hold and fail the request.
        await this.balances.releaseHold(
          manager,
          dims,
          days,
          request.id,
          LedgerSource.HCM_REALTIME,
          `HCM refused: ${err.code}`,
        );
        request.status = RequestStatus.FAILED;
        request.hcmFilingStatus = HcmFilingStatus.FAILED;
        request.failureReason = `${err.code}: ${err.message}`;
      } else {
        // The HCM refused a refund credit — flag it; balance integrity is restored by reconcile.
        request.hcmFilingStatus = HcmFilingStatus.FAILED;
        request.failureReason = `Refund refused: ${err.code}: ${err.message}`;
      }
      await manager.save(request);
    });
  }

  private async safeReconcile(item: HcmOutbox): Promise<void> {
    try {
      await this.reconciliation.reconcileDimension(toDimensions(item));
    } catch (err) {
      this.logger.warn(`Post-failure reconcile failed for request ${item.requestId}: ${err}`);
    }
  }

  private async loadRequest(manager: EntityManager, id: string): Promise<TimeOffRequest> {
    const request = await manager.findOne(TimeOffRequest, { where: { id } });
    if (!request) throw new Error(`Outbox references unknown request ${id}`);
    return request;
  }
}
