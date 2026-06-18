import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { LedgerEntryType, LedgerSource } from '../../common/enums';

/**
 * Append-only ledger of every change to a balance bucket. Never updated or deleted.
 *
 * This is the audit trail and the primary instrument the test-suite uses to prove balance
 * integrity: replaying the deltas must always reconstruct the current (balanceDays, pendingDays).
 */
@Entity('balance_ledger')
@Index('IDX_ledger_dimensions', ['employeeId', 'locationId', 'leaveType'])
@Index('IDX_ledger_request', ['requestId'])
export class BalanceLedger {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  employeeId: string;

  @Column({ type: 'varchar' })
  locationId: string;

  @Column({ type: 'varchar' })
  leaveType: string;

  @Column({ type: 'varchar' })
  entryType: LedgerEntryType;

  @Column({ type: 'varchar' })
  source: LedgerSource;

  /** Signed change to balanceDays applied by this entry (0 for pure holds/releases). */
  @Column({ type: 'real', default: 0 })
  balanceDelta: number;

  /** Signed change to pendingDays applied by this entry. */
  @Column({ type: 'real', default: 0 })
  pendingDelta: number;

  /** Snapshot of balanceDays immediately after this entry was applied. */
  @Column({ type: 'real' })
  balanceAfter: number;

  /** Snapshot of pendingDays immediately after this entry was applied. */
  @Column({ type: 'real' })
  pendingAfter: number;

  @Column({ type: 'varchar', nullable: true })
  requestId: string | null;

  /** Free-form structured context (e.g. HCM raw value, reconcile reason). */
  @Column({ type: 'simple-json', nullable: true })
  metadata: Record<string, unknown> | null;

  /**
   * App-controlled event time in epoch milliseconds. Used by reconciliation to order confirmed
   * filings against an HCM snapshot's `generatedAt`. We do NOT rely on `createdAt` for this because
   * SQLite's CURRENT_TIMESTAMP is only second-precision, which loses sub-second ordering.
   */
  @Column({ type: 'integer', default: 0 })
  occurredAtMs: number;

  @CreateDateColumn()
  createdAt: Date;
}
