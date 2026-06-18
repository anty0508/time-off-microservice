import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { BalanceDimensions, dimensionsKey } from '../common/dimensions';
import { LedgerEntryType, LedgerSource } from '../common/enums';
import { roundDays } from '../common/days.util';
import { InsufficientBalanceException, InvalidDimensionException } from '../common/exceptions';
import { Balance } from '../database/entities';
import { HcmClient } from '../hcm/hcm.client';
import { HcmTransientError } from '../hcm/hcm.types';
import { LedgerService } from '../ledger/ledger.service';
import { availableDays, BalanceView, toBalanceView } from './balance.view';

/**
 * Owns every mutation of a balance bucket and the matching ledger entry. All mutating methods take
 * the caller's {@link EntityManager} so the balance change, the ledger write, and the caller's own
 * writes (e.g. the request row) commit in one atomic transaction.
 *
 * Accounting model (per (employeeId, locationId, leaveType)):
 *   balanceDays  = authoritative balance last known from the HCM, +/- confirmed filings
 *   pendingDays  = days held by in-flight requests (not yet confirmed with the HCM)
 *   available    = balanceDays - pendingDays   <-- never allowed to go negative by a *new* hold
 */
@Injectable()
export class BalancesService {
  private readonly logger = new Logger(BalancesService.name);

  constructor(
    @InjectRepository(Balance) private readonly balances: Repository<Balance>,
    private readonly ledger: LedgerService,
    private readonly hcm: HcmClient,
  ) {}

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  async findBalance(dims: BalanceDimensions, manager?: EntityManager): Promise<Balance | null> {
    return this.repo(manager).findOne({ where: dims });
  }

  async getBalanceView(dims: BalanceDimensions): Promise<BalanceView | null> {
    const balance = await this.findBalance(dims);
    return balance ? toBalanceView(balance) : null;
  }

  async listBalanceViews(filter: {
    employeeId?: string;
    locationId?: string;
    leaveType?: string;
  }): Promise<BalanceView[]> {
    const where: Record<string, string> = {};
    if (filter.employeeId) where.employeeId = filter.employeeId;
    if (filter.locationId) where.locationId = filter.locationId;
    if (filter.leaveType) where.leaveType = filter.leaveType;
    const rows = await this.balances.find({ where, order: { employeeId: 'ASC' } });
    return rows.map(toBalanceView);
  }

  // ---------------------------------------------------------------------------
  // Seeding / discovery
  // ---------------------------------------------------------------------------

  /**
   * Return the local balance for the dimensions, lazily seeding it from the HCM realtime API the
   * first time we see a bucket. If the HCM has no such bucket either, the dimension combination is
   * invalid and we reject (mirroring HCM behaviour, but not relying on it).
   *
   * Performs the HCM network call OUTSIDE any DB transaction; safe to call before opening one.
   */
  async ensureBalance(dims: BalanceDimensions): Promise<Balance> {
    const existing = await this.findBalance(dims);
    if (existing) return existing;

    let snapshot;
    try {
      snapshot = await this.hcm.getBalance(dims);
    } catch (err) {
      if (err instanceof HcmTransientError) {
        // We cannot confirm the dimension is valid while the HCM is unreachable; surface as such.
        throw err;
      }
      throw err;
    }

    if (!snapshot) {
      throw new InvalidDimensionException({ ...dims });
    }

    return this.seedBalance(dims, snapshot.balanceDays);
  }

  /** Idempotently insert a balance row seeded from an HCM figure. */
  private async seedBalance(dims: BalanceDimensions, balanceDays: number): Promise<Balance> {
    try {
      const created = this.balances.create({
        ...dims,
        balanceDays: roundDays(balanceDays),
        pendingDays: 0,
        hcmAsOf: new Date(),
      });
      const saved = await this.balances.save(created);
      this.logger.log(`Seeded balance ${dimensionsKey(dims)} = ${balanceDays} from HCM`);
      return saved;
    } catch (err) {
      // Lost the race to another seeder — the unique index rejected us; re-read the winner's row.
      const existing = await this.findBalance(dims);
      if (existing) return existing;
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Mutations (all run inside the caller's transaction)
  // ---------------------------------------------------------------------------

  /**
   * Reserve (hold) `days` against available balance. Throws {@link InsufficientBalanceException}
   * if the hold would over-draw. This is the authoritative local guard — we never depend on the
   * HCM to catch an over-draw.
   */
  async reserve(
    manager: EntityManager,
    dims: BalanceDimensions,
    days: number,
    requestId: string,
  ): Promise<Balance> {
    const balance = await this.loadForUpdate(manager, dims);
    const available = availableDays(balance);
    if (roundDays(days) > available) {
      throw new InsufficientBalanceException({ requested: roundDays(days), available, ...dims });
    }
    balance.pendingDays = roundDays(balance.pendingDays + days);
    const saved = await manager.save(balance);
    await this.ledger.record(manager, {
      dims,
      entryType: LedgerEntryType.HOLD,
      source: LedgerSource.EMPLOYEE_REQUEST,
      pendingDelta: days,
      balanceAfter: saved.balanceDays,
      pendingAfter: saved.pendingDays,
      requestId,
    });
    return saved;
  }

  /** Release a previously-held reservation (reject, cancel-before-filing, or HCM refusal). */
  async releaseHold(
    manager: EntityManager,
    dims: BalanceDimensions,
    days: number,
    requestId: string,
    source: LedgerSource,
    reason?: string,
  ): Promise<Balance> {
    const balance = await this.loadForUpdate(manager, dims);
    balance.pendingDays = roundDays(Math.max(0, balance.pendingDays - days));
    const saved = await manager.save(balance);
    await this.ledger.record(manager, {
      dims,
      entryType: LedgerEntryType.RELEASE,
      source,
      pendingDelta: -days,
      balanceAfter: saved.balanceDays,
      pendingAfter: saved.pendingDays,
      requestId,
      metadata: reason ? { reason } : null,
    });
    return saved;
  }

  /**
   * Convert a hold into a confirmed debit once the HCM has accepted the filing: subtract from both
   * the authoritative balance and the pending hold.
   */
  async confirmDebit(
    manager: EntityManager,
    dims: BalanceDimensions,
    days: number,
    requestId: string,
    metadata?: Record<string, unknown>,
  ): Promise<Balance> {
    const balance = await this.loadForUpdate(manager, dims);
    balance.balanceDays = roundDays(balance.balanceDays - days);
    balance.pendingDays = roundDays(Math.max(0, balance.pendingDays - days));
    const saved = await manager.save(balance);
    await this.ledger.record(manager, {
      dims,
      entryType: LedgerEntryType.DEBIT,
      source: LedgerSource.HCM_REALTIME,
      balanceDelta: -days,
      pendingDelta: -days,
      balanceAfter: saved.balanceDays,
      pendingAfter: saved.pendingDays,
      requestId,
      metadata,
    });
    return saved;
  }

  /** Add days back to the authoritative balance (cancellation refund). */
  async credit(
    manager: EntityManager,
    dims: BalanceDimensions,
    days: number,
    requestId: string | null,
    source: LedgerSource,
    entryType: LedgerEntryType = LedgerEntryType.CREDIT,
    metadata?: Record<string, unknown>,
  ): Promise<Balance> {
    const balance = await this.loadForUpdate(manager, dims);
    balance.balanceDays = roundDays(balance.balanceDays + days);
    const saved = await manager.save(balance);
    await this.ledger.record(manager, {
      dims,
      entryType,
      source,
      balanceDelta: days,
      balanceAfter: saved.balanceDays,
      pendingAfter: saved.pendingDays,
      requestId,
      metadata,
    });
    return saved;
  }

  /**
   * Reconcile a bucket to an HCM authoritative snapshot (batch or realtime push).
   *
   * `target` is the figure the local balanceDays should become AFTER accounting for any confirmed
   * filings the snapshot did not yet include (the caller computes that adjustment). Local holds
   * (pendingDays) are preserved — the HCM doesn't know about them.
   *
   * Stale snapshots (asOf older than what we last applied) are ignored. If the reconciled balance
   * leaves us over-committed (available < 0), a DISCREPANCY entry is recorded and a warning logged;
   * we do NOT silently mutate existing holds.
   */
  async applyHcmSnapshot(
    manager: EntityManager,
    dims: BalanceDimensions,
    target: number,
    asOf: Date,
    metadata: Record<string, unknown>,
  ): Promise<{ balance: Balance; skipped: boolean; overcommitted: boolean }> {
    const balance =
      (await this.loadForUpdate(manager, dims, false)) ?? this.createDetached(manager, dims);

    if (balance.hcmAsOf && asOf.getTime() <= balance.hcmAsOf.getTime()) {
      return { balance, skipped: true, overcommitted: false };
    }

    const previous = balance.balanceDays;
    const rounded = roundDays(target);
    balance.balanceDays = rounded;
    balance.hcmAsOf = asOf;
    const saved = await manager.save(balance);

    await this.ledger.record(manager, {
      dims,
      entryType: LedgerEntryType.RECONCILE,
      source: LedgerSource.HCM_BATCH,
      balanceDelta: roundDays(rounded - previous),
      balanceAfter: saved.balanceDays,
      pendingAfter: saved.pendingDays,
      metadata: { ...metadata, previousBalance: previous },
    });

    const overcommitted = availableDays(saved) < 0;
    if (overcommitted) {
      this.logger.warn(
        `Over-committed after reconcile for ${dimensionsKey(dims)}: ` +
          `balance=${saved.balanceDays} pending=${saved.pendingDays}`,
      );
      await this.ledger.record(manager, {
        dims,
        entryType: LedgerEntryType.DISCREPANCY,
        source: LedgerSource.RECONCILER,
        balanceAfter: saved.balanceDays,
        pendingAfter: saved.pendingDays,
        metadata: { reason: 'OVER_COMMITTED', available: availableDays(saved) },
      });
    }
    return { balance: saved, skipped: false, overcommitted };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private repo(manager?: EntityManager): Repository<Balance> {
    return manager ? manager.getRepository(Balance) : this.balances;
  }

  private async loadForUpdate(
    manager: EntityManager,
    dims: BalanceDimensions,
    required = true,
  ): Promise<Balance> {
    const balance = await manager.findOne(Balance, { where: dims });
    if (!balance && required) {
      throw new InvalidDimensionException({ ...dims });
    }
    return balance as Balance;
  }

  private createDetached(manager: EntityManager, dims: BalanceDimensions): Balance {
    return manager.create(Balance, { ...dims, balanceDays: 0, pendingDays: 0, hcmAsOf: null });
  }
}
