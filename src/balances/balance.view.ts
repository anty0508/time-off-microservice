import { roundDays } from '../common/days.util';
import { Balance } from '../database/entities';

/** Public, API-facing shape of a balance, including the derived `availableDays`. */
export interface BalanceView {
  employeeId: string;
  locationId: string;
  leaveType: string;
  balanceDays: number;
  pendingDays: number;
  availableDays: number;
  hcmAsOf: string | null;
  updatedAt: string;
}

export function availableDays(balance: Pick<Balance, 'balanceDays' | 'pendingDays'>): number {
  return roundDays(balance.balanceDays - balance.pendingDays);
}

export function toBalanceView(balance: Balance): BalanceView {
  return {
    employeeId: balance.employeeId,
    locationId: balance.locationId,
    leaveType: balance.leaveType,
    balanceDays: roundDays(balance.balanceDays),
    pendingDays: roundDays(balance.pendingDays),
    availableDays: availableDays(balance),
    hcmAsOf: balance.hcmAsOf ? balance.hcmAsOf.toISOString() : null,
    updatedAt: balance.updatedAt ? balance.updatedAt.toISOString() : new Date().toISOString(),
  };
}
