/**
 * The system supports time-off balances along the dimensions (employeeId, locationId, leaveType).
 * The assessment states balances are "per-employee per-location"; `leaveType` is an additional
 * supported dimension that defaults to ANNUAL so the base case is exactly per-employee/per-location.
 */
export const DEFAULT_LEAVE_TYPE = 'ANNUAL';

/**
 * Balances are stored as floating point days (the HCM may grant fractional accruals). All balance
 * arithmetic is rounded to this many decimal places to avoid IEEE-754 drift (e.g. 0.1 + 0.2).
 */
export const DAYS_DECIMAL_PRECISION = 4;

/** Header an API client may send to make POST /time-off-requests idempotent. */
export const IDEMPOTENCY_HEADER = 'idempotency-key';
