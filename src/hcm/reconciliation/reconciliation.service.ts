import { Injectable, Logger } from '@nestjs/common';
import { EntityManager, In } from 'typeorm';
import { BalancesService } from '../../balances/balances.service';
import { availableDays } from '../../balances/balance.view';
import { BalanceDimensions, dimensionsKey, toDimensions } from '../../common/dimensions';
import { LedgerEntryType, LedgerSource } from '../../common/enums';
import { roundDays } from '../../common/days.util';
import { TransactionRunner } from '../../database/transaction.runner';
import { BalanceLedger } from '../../database/entities';
import { HcmClient } from '../hcm.client';
import { HcmBalanceSnapshot } from '../hcm.types';

export interface ReconcileSummary {
  applied: number;
  skipped: number;
  overcommitted: number;
  buckets: number;
}

/**
 * Reconciles the local balances against the HCM source of truth. The HCM may change balances
 * independently of ExampleHR (work-anniversary bonus, start-of-year refresh), so the HCM figure
 * always wins for `balanceDays`; local holds (`pendingDays`) are preserved.
 *
 * Timing-window correctness: a batch/snapshot is generated at some `asOf` time. Debits/credits we
 * confirmed with the HCM *after* that time are not yet reflected in the snapshot, so we re-apply
 * them on top of the snapshot value (read from the ledger). This prevents a stale snapshot from
 * transiently "refunding" a balance we already legitimately consumed.
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    private readonly balances: BalancesService,
    private readonly hcm: HcmClient,
    private readonly tx: TransactionRunner,
  ) {}

  /** Pull the whole corpus from the HCM batch endpoint and reconcile every bucket. */
  async pullAndReconcile(): Promise<ReconcileSummary> {
    const batch = await this.hcm.getBatchBalances();
    const generatedAt = this.parseDate(batch.generatedAt);
    return this.ingest(batch.balances, generatedAt);
  }

  /** Reconcile a set of snapshots pushed to us (HCM webhook) or pulled from the batch endpoint. */
  async ingest(snapshots: HcmBalanceSnapshot[], generatedAt: Date): Promise<ReconcileSummary> {
    const summary: ReconcileSummary = {
      applied: 0,
      skipped: 0,
      overcommitted: 0,
      buckets: snapshots.length,
    };
    for (const snap of snapshots) {
      const dims = toDimensions(snap);
      const result = await this.reconcileBucket(dims, snap.balanceDays, generatedAt);
      if (result.skipped) summary.skipped += 1;
      else summary.applied += 1;
      if (result.overcommitted) summary.overcommitted += 1;
    }
    if (summary.overcommitted > 0) {
      this.logger.warn(`Reconcile produced ${summary.overcommitted} over-committed bucket(s)`);
    }
    return summary;
  }

  /** Reconcile a single bucket against a realtime HCM read (used after a filing is refused). */
  async reconcileDimension(dims: BalanceDimensions): Promise<void> {
    const snapshot = await this.hcm.getBalance(dims);
    if (!snapshot) {
      this.logger.warn(`HCM has no balance for ${dimensionsKey(dims)} during reconcile`);
      return;
    }
    await this.reconcileBucket(dims, snapshot.balanceDays, new Date());
  }

  private async reconcileBucket(
    dims: BalanceDimensions,
    hcmBalance: number,
    generatedAt: Date,
  ): Promise<{ skipped: boolean; overcommitted: boolean }> {
    return this.tx.run(async (manager) => {
      const adjustment = await this.postSnapshotAdjustment(manager, dims, generatedAt);
      const target = roundDays(hcmBalance + adjustment);
      const { skipped, overcommitted } = await this.balances.applyHcmSnapshot(
        manager,
        dims,
        target,
        generatedAt,
        { hcmBalance, adjustment, source: LedgerSource.HCM_BATCH },
      );
      return { skipped, overcommitted };
    });
  }

  /**
   * Sum of HCM-confirmed balance deltas recorded *after* the snapshot was generated — i.e. filings
   * the snapshot does not yet reflect. Debits are negative, credits positive, so adding this to the
   * HCM figure yields the correct current authoritative balance.
   */
  private async postSnapshotAdjustment(
    manager: EntityManager,
    dims: BalanceDimensions,
    generatedAt: Date,
  ): Promise<number> {
    const rows = await manager.getRepository(BalanceLedger).find({
      where: {
        ...dims,
        source: LedgerSource.HCM_REALTIME,
        entryType: In([LedgerEntryType.DEBIT, LedgerEntryType.CREDIT]),
      },
    });
    const adjustment = rows
      .filter((r) => r.occurredAtMs > generatedAt.getTime())
      .reduce((sum, r) => sum + r.balanceDelta, 0);
    return roundDays(adjustment);
  }

  private parseDate(value: string | undefined): Date {
    if (!value) return new Date();
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? new Date() : d;
  }

  /** Exposed for tests/inspection: whether a bucket is currently over-committed. */
  isOvercommitted = (b: { balanceDays: number; pendingDays: number }): boolean =>
    availableDays(b) < 0;
}
