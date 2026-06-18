import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  VersionColumn,
} from 'typeorm';

/**
 * The local projection of an HCM balance for a (employeeId, locationId, leaveType) bucket.
 *
 * `balanceDays`  — the authoritative balance as last known from the HCM (the source of truth),
 *                  adjusted by debits/credits we have *confirmed* with the HCM.
 * `pendingDays`  — days currently *held* by in-flight requests (PENDING, or APPROVED but not yet
 *                  confirmed with the HCM). These holds are local to ExampleHR; the HCM does not
 *                  know about them yet.
 *
 * The figure shown to employees and checked on every new request is:
 *     available = balanceDays - pendingDays
 *
 * `version` provides optimistic concurrency control so two simultaneous requests cannot both
 * consume the same available balance (lost-update prevention).
 */
@Entity('balances')
@Index('UQ_balance_dimensions', ['employeeId', 'locationId', 'leaveType'], { unique: true })
export class Balance {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  employeeId: string;

  @Column({ type: 'varchar' })
  locationId: string;

  @Column({ type: 'varchar' })
  leaveType: string;

  @Column({ type: 'real', default: 0 })
  balanceDays: number;

  @Column({ type: 'real', default: 0 })
  pendingDays: number;

  /** The HCM snapshot timestamp this balance was last reconciled against (for staleness checks). */
  @Column({ type: 'datetime', nullable: true })
  hcmAsOf: Date | null;

  @VersionColumn()
  version: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
