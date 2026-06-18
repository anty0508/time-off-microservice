import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  VersionColumn,
} from 'typeorm';
import { OutboxOperation, OutboxStatus } from '../../common/enums';

/**
 * Transactional-outbox item. When a request is approved/cancelled, the local state change and the
 * intent to call the HCM are committed in the *same* DB transaction by inserting one of these rows.
 * A background processor then reliably delivers it to the HCM with retries/back-off, guaranteeing
 * at-least-once delivery without losing the side-effect if the process crashes mid-call.
 */
@Entity('hcm_outbox')
@Index('IDX_outbox_dispatch', ['status', 'nextAttemptAt'])
export class HcmOutbox {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  operation: OutboxOperation;

  @Column({ type: 'varchar' })
  requestId: string;

  @Column({ type: 'varchar' })
  employeeId: string;

  @Column({ type: 'varchar' })
  locationId: string;

  @Column({ type: 'varchar' })
  leaveType: string;

  /** Signed delta to file with the HCM (negative for a debit, positive for a credit/refund). */
  @Column({ type: 'real' })
  deltaDays: number;

  /** Idempotency key sent to the HCM so retries don't double-apply the delta. */
  @Column({ type: 'varchar' })
  idempotencyKey: string;

  @Column({ type: 'varchar', default: OutboxStatus.PENDING })
  status: OutboxStatus;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ type: 'int', default: 8 })
  maxAttempts: number;

  @Column({ type: 'datetime' })
  nextAttemptAt: Date;

  @Column({ type: 'varchar', nullable: true })
  lastError: string | null;

  @Column({ type: 'varchar', nullable: true })
  hcmReference: string | null;

  @VersionColumn()
  version: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
