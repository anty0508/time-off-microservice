import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { BalanceDimensions } from '../common/dimensions';
import { LedgerEntryType, LedgerSource } from '../common/enums';
import { roundDays } from '../common/days.util';
import { BalanceLedger } from '../database/entities';

export interface LedgerRecordInput {
  dims: BalanceDimensions;
  entryType: LedgerEntryType;
  source: LedgerSource;
  balanceDelta?: number;
  pendingDelta?: number;
  balanceAfter: number;
  pendingAfter: number;
  requestId?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Writes append-only entries to the balance ledger. Always invoked within the caller's
 * transaction (the `manager` is threaded in) so a ledger entry and the balance mutation it
 * describes commit atomically.
 */
@Injectable()
export class LedgerService {
  async record(manager: EntityManager, input: LedgerRecordInput): Promise<BalanceLedger> {
    const entry = manager.create(BalanceLedger, {
      employeeId: input.dims.employeeId,
      locationId: input.dims.locationId,
      leaveType: input.dims.leaveType,
      entryType: input.entryType,
      source: input.source,
      balanceDelta: roundDays(input.balanceDelta ?? 0),
      pendingDelta: roundDays(input.pendingDelta ?? 0),
      balanceAfter: roundDays(input.balanceAfter),
      pendingAfter: roundDays(input.pendingAfter),
      requestId: input.requestId ?? null,
      metadata: input.metadata ?? null,
      occurredAtMs: Date.now(),
    });
    return manager.save(entry);
  }
}
