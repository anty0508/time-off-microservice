import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, LessThanOrEqual, Repository } from 'typeorm';
import { AppConfig } from '../../config/configuration';
import { BalanceDimensions } from '../../common/dimensions';
import { OutboxOperation, OutboxStatus } from '../../common/enums';
import { roundDays } from '../../common/days.util';
import { HcmOutbox } from '../../database/entities';

const ACTIVE_STATUSES = [OutboxStatus.PENDING, OutboxStatus.RETRY];

export interface EnqueueInput {
  operation: OutboxOperation;
  requestId: string;
  dims: BalanceDimensions;
  /** Signed delta to file (negative debit / positive credit). */
  deltaDays: number;
}

/**
 * Manages transactional-outbox items: enqueueing them within the producer's transaction, claiming
 * due items for the processor, and recording delivery outcomes (sent / retry / dead / cancelled).
 */
@Injectable()
export class OutboxService {
  private readonly maxAttempts: number;
  private readonly retryBaseMs: number;

  constructor(
    @InjectRepository(HcmOutbox) private readonly outbox: Repository<HcmOutbox>,
    config: ConfigService<AppConfig, true>,
  ) {
    this.maxAttempts = config.get('hcm', { infer: true }).maxRetries;
    this.retryBaseMs = config.get('outbox', { infer: true }).retryBaseMs;
  }

  /** Insert a new outbox item in the caller's transaction. */
  async enqueue(manager: EntityManager, input: EnqueueInput): Promise<HcmOutbox> {
    const item = manager.create(HcmOutbox, {
      operation: input.operation,
      requestId: input.requestId,
      employeeId: input.dims.employeeId,
      locationId: input.dims.locationId,
      leaveType: input.dims.leaveType,
      deltaDays: roundDays(input.deltaDays),
      idempotencyKey: `${input.requestId}:${input.operation}`,
      status: OutboxStatus.PENDING,
      attempts: 0,
      maxAttempts: this.maxAttempts,
      nextAttemptAt: new Date(),
    });
    return manager.save(item);
  }

  /** Cancel any still-undelivered items for a request (e.g. request cancelled before filing). */
  async cancelForRequest(manager: EntityManager, requestId: string): Promise<number> {
    const result = await manager.update(
      HcmOutbox,
      { requestId, status: In(ACTIVE_STATUSES) },
      { status: OutboxStatus.CANCELLED },
    );
    return result.affected ?? 0;
  }

  /** Return outbox items ready for delivery. `force` ignores the back-off schedule (tests). */
  async claimDue(limit: number, force = false): Promise<HcmOutbox[]> {
    return this.outbox.find({
      where: force
        ? { status: In(ACTIVE_STATUSES) }
        : { status: In(ACTIVE_STATUSES), nextAttemptAt: LessThanOrEqual(new Date()) },
      order: { createdAt: 'ASC' },
      take: limit,
    });
  }

  /** List outbox items (newest first) for inspection/debugging, optionally filtered by status. */
  async list(filter: { status?: OutboxStatus; requestId?: string } = {}): Promise<HcmOutbox[]> {
    const where: Record<string, unknown> = {};
    if (filter.status) where.status = filter.status;
    if (filter.requestId) where.requestId = filter.requestId;
    return this.outbox.find({ where, order: { createdAt: 'DESC' }, take: 200 });
  }

  /** Re-load an item inside a transaction; null if it is no longer active. */
  async loadActive(manager: EntityManager, id: string): Promise<HcmOutbox | null> {
    const item = await manager.findOne(HcmOutbox, { where: { id } });
    if (!item || !ACTIVE_STATUSES.includes(item.status)) return null;
    return item;
  }

  async markSent(manager: EntityManager, item: HcmOutbox, reference: string): Promise<void> {
    item.status = OutboxStatus.SENT;
    item.hcmReference = reference;
    item.lastError = null;
    await manager.save(item);
  }

  async markFailed(manager: EntityManager, item: HcmOutbox, error: string): Promise<void> {
    item.status = OutboxStatus.FAILED;
    item.lastError = error;
    await manager.save(item);
  }

  /**
   * Record a transient failure: increment attempts and either schedule an exponential-back-off
   * retry or mark the item DEAD once attempts are exhausted.
   */
  async scheduleRetry(
    manager: EntityManager,
    item: HcmOutbox,
    error: string,
  ): Promise<OutboxStatus> {
    item.attempts += 1;
    item.lastError = error;
    if (item.attempts >= item.maxAttempts) {
      item.status = OutboxStatus.DEAD;
    } else {
      item.status = OutboxStatus.RETRY;
      const delay = Math.min(this.retryBaseMs * 2 ** (item.attempts - 1), 60_000);
      item.nextAttemptAt = new Date(Date.now() + delay);
    }
    await manager.save(item);
    return item.status;
  }
}
