import { DEFAULT_LEAVE_TYPE } from './constants';

/**
 * The set of dimensions that uniquely identify a balance bucket.
 * Per the assessment, balances are per-employee per-location; `leaveType` is an extra dimension.
 */
export interface BalanceDimensions {
  employeeId: string;
  locationId: string;
  leaveType: string;
}

/** Build a normalized dimensions object, defaulting leaveType. */
export function toDimensions(input: {
  employeeId: string;
  locationId: string;
  leaveType?: string | null;
}): BalanceDimensions {
  return {
    employeeId: input.employeeId,
    locationId: input.locationId,
    leaveType: input.leaveType?.trim() || DEFAULT_LEAVE_TYPE,
  };
}

/** Stable string key for a dimensions tuple (used for maps / idempotency / logging). */
export function dimensionsKey(d: BalanceDimensions): string {
  return `${d.employeeId}::${d.locationId}::${d.leaveType}`;
}
