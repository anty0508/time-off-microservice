import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  VersionColumn,
} from 'typeorm';
import { HcmFilingStatus, RequestStatus } from '../../common/enums';

/**
 * A time-off request and its full lifecycle. This is the aggregate root the API operates on.
 */
@Entity('time_off_requests')
@Index('IDX_request_employee_location', ['employeeId', 'locationId'])
@Index('IDX_request_status', ['status'])
export class TimeOffRequest {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  employeeId: string;

  @Column({ type: 'varchar' })
  locationId: string;

  @Column({ type: 'varchar' })
  leaveType: string;

  /** Inclusive start/end calendar dates (YYYY-MM-DD). */
  @Column({ type: 'varchar' })
  startDate: string;

  @Column({ type: 'varchar' })
  endDate: string;

  /** Number of days consumed, derived server-side from the date range. */
  @Column({ type: 'real' })
  numberOfDays: number;

  @Column({ type: 'varchar', default: RequestStatus.PENDING })
  status: RequestStatus;

  @Column({ type: 'varchar', default: HcmFilingStatus.NOT_FILED })
  hcmFilingStatus: HcmFilingStatus;

  /** Reference returned by the HCM once the debit/credit is confirmed. */
  @Column({ type: 'varchar', nullable: true })
  hcmReference: string | null;

  @Column({ type: 'datetime', nullable: true })
  hcmConfirmedAt: Date | null;

  /**
   * Optional client-supplied idempotency key. A unique (partial) index makes retried POSTs safe:
   * the second create with the same key returns the original request instead of creating a new one.
   */
  @Index('UQ_request_idempotency', { unique: true, where: '"idempotencyKey" IS NOT NULL' })
  @Column({ type: 'varchar', nullable: true })
  idempotencyKey: string | null;

  @Column({ type: 'varchar', nullable: true })
  reason: string | null;

  @Column({ type: 'varchar', nullable: true })
  approverId: string | null;

  /** Manager-provided reason for a reject/approve decision. */
  @Column({ type: 'varchar', nullable: true })
  decisionReason: string | null;

  /** Populated when the HCM authoritatively refuses a filing (defensive path). */
  @Column({ type: 'varchar', nullable: true })
  failureReason: string | null;

  @VersionColumn()
  version: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
