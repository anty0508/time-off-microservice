import { BalanceDimensions } from '../common/dimensions';

/** A single balance figure as reported by the HCM (the source of truth). */
export interface HcmBalanceSnapshot {
  employeeId: string;
  locationId: string;
  leaveType: string;
  balanceDays: number;
}

/** The HCM batch endpoint returns the whole corpus plus the snapshot time it was generated. */
export interface HcmBatchResponse {
  generatedAt: string;
  balances: HcmBalanceSnapshot[];
}

/** Result of filing a delta against the HCM realtime API. */
export interface HcmFileResult {
  reference: string;
  /** The HCM's resulting balance, when it chooses to return it. */
  balanceDays?: number;
}

export interface HcmFileRequest {
  dims: BalanceDimensions;
  /** Signed delta — negative to consume balance (debit), positive to refund (credit). */
  deltaDays: number;
  requestId: string;
  idempotencyKey: string;
}

/**
 * A *business* refusal from the HCM (insufficient balance, invalid dimension combination, ...).
 * Terminal — retrying will not help. Drives the defensive "HCM said no" branch.
 */
export class HcmBusinessError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'HcmBusinessError';
  }
}

/**
 * A *transient* failure (timeout, network error, 5xx, 429). Retrying later may succeed.
 */
export class HcmTransientError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'HcmTransientError';
  }
}
