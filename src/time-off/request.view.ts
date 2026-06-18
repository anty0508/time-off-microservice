import { TimeOffRequest } from '../database/entities';
import { HcmFilingStatus, RequestStatus } from '../common/enums';

/** API-facing shape of a time-off request. */
export interface RequestView {
  id: string;
  employeeId: string;
  locationId: string;
  leaveType: string;
  startDate: string;
  endDate: string;
  numberOfDays: number;
  status: RequestStatus;
  hcmFilingStatus: HcmFilingStatus;
  hcmReference: string | null;
  reason: string | null;
  approverId: string | null;
  decisionReason: string | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toRequestView(r: TimeOffRequest): RequestView {
  return {
    id: r.id,
    employeeId: r.employeeId,
    locationId: r.locationId,
    leaveType: r.leaveType,
    startDate: r.startDate,
    endDate: r.endDate,
    numberOfDays: r.numberOfDays,
    status: r.status,
    hcmFilingStatus: r.hcmFilingStatus,
    hcmReference: r.hcmReference,
    reason: r.reason,
    approverId: r.approverId,
    decisionReason: r.decisionReason,
    failureReason: r.failureReason,
    createdAt: r.createdAt ? r.createdAt.toISOString() : new Date().toISOString(),
    updatedAt: r.updatedAt ? r.updatedAt.toISOString() : new Date().toISOString(),
  };
}
