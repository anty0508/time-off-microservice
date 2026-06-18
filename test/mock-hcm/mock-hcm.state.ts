/**
 * In-memory state for the mock HCM. This is a *real* server with *real* (if simple) logic that
 * simulates the behaviours called out in the assessment:
 *  - it is the source of truth for balances;
 *  - it can change balances independently of ExampleHR (work-anniversary bonus / yearly refresh);
 *  - it normally validates filings (balance + dimension) but can be configured NOT to — so we can
 *    prove ExampleHR is defensive and never relies on the HCM to catch an over-draw;
 *  - it can be made to fail transiently to exercise retry/back-off.
 */

const DEFAULT_LEAVE_TYPE = 'ANNUAL';

export type FailMode = 'transient' | 'business';

export interface MockHcmConfig {
  /** When true (default), reject filings that would drive a balance negative. */
  enforceBalance: boolean;
  /** When true (default), reject filings against an unknown (un-seeded) dimension. */
  enforceDimensions: boolean;
  /** Artificial latency added to every realtime call (ms). */
  latencyMs: number;
  /** Number of subsequent /time-off calls to fail before succeeding. */
  failNext: number;
  /** How forced failures present themselves. */
  failMode: FailMode;
}

function key(employeeId: string, locationId: string, leaveType: string): string {
  return `${employeeId}::${locationId}::${leaveType}`;
}

function round(n: number): number {
  return Math.round((n + Number.EPSILON) * 1e4) / 1e4;
}

export class MockHcmState {
  private balances = new Map<string, number>();
  /** idempotencyKey -> the reference returned previously (so retries don't double-apply). */
  private processed = new Map<string, { reference: string; balanceDays: number }>();
  private seq = 0;

  config: MockHcmConfig = {
    enforceBalance: true,
    enforceDimensions: true,
    latencyMs: 0,
    failNext: 0,
    failMode: 'transient',
  };

  reset(): void {
    this.balances.clear();
    this.processed.clear();
    this.seq = 0;
    this.config = {
      enforceBalance: true,
      enforceDimensions: true,
      latencyMs: 0,
      failNext: 0,
      failMode: 'transient',
    };
  }

  setConfig(patch: Partial<MockHcmConfig>): void {
    this.config = { ...this.config, ...patch };
  }

  norm(leaveType?: string): string {
    return leaveType?.trim() || DEFAULT_LEAVE_TYPE;
  }

  has(employeeId: string, locationId: string, leaveType: string): boolean {
    return this.balances.has(key(employeeId, locationId, leaveType));
  }

  get(employeeId: string, locationId: string, leaveType: string): number | undefined {
    return this.balances.get(key(employeeId, locationId, leaveType));
  }

  set(employeeId: string, locationId: string, leaveType: string, balanceDays: number): void {
    this.balances.set(key(employeeId, locationId, leaveType), round(balanceDays));
  }

  /** Apply a signed delta to a bucket, returning the new value. */
  applyDelta(employeeId: string, locationId: string, leaveType: string, delta: number): number {
    const current = this.balances.get(key(employeeId, locationId, leaveType)) ?? 0;
    const next = round(current + delta);
    this.balances.set(key(employeeId, locationId, leaveType), next);
    return next;
  }

  nextReference(): string {
    this.seq += 1;
    return `HCM-${this.seq}`;
  }

  rememberIdempotent(idempotencyKey: string, reference: string, balanceDays: number): void {
    this.processed.set(idempotencyKey, { reference, balanceDays });
  }

  getIdempotent(idempotencyKey: string): { reference: string; balanceDays: number } | undefined {
    return this.processed.get(idempotencyKey);
  }

  /** The whole corpus, for the batch endpoint. */
  corpus(): Array<{
    employeeId: string;
    locationId: string;
    leaveType: string;
    balanceDays: number;
  }> {
    return [...this.balances.entries()].map(([k, balanceDays]) => {
      const [employeeId, locationId, leaveType] = k.split('::');
      return { employeeId, locationId, leaveType, balanceDays };
    });
  }
}
