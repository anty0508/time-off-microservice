/**
 * Lifecycle status of a time-off request as tracked by ExampleHR.
 *
 *  PENDING   -> created by an employee, balance is *held* locally, awaiting a manager decision.
 *  APPROVED  -> a manager approved it; the debit is being (or has been) filed with the HCM.
 *  REJECTED  -> a manager rejected it; the held balance was released.
 *  CANCELLED -> the request was cancelled (by employee/manager); any debit is refunded.
 *  FAILED    -> the HCM authoritatively refused the filing (e.g. insufficient balance / invalid
 *               dimension). The hold is released and the request is dead. This is the "defensive"
 *               branch for when our local view drifted from the HCM source of truth.
 */
export enum RequestStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  CANCELLED = 'CANCELLED',
  FAILED = 'FAILED',
}

/**
 * Tracks the state of the side-effect that files the request against the HCM.
 * This is intentionally separate from {@link RequestStatus}: a request can be APPROVED locally
 * while its HCM filing is still PENDING (async, retried via the outbox).
 */
export enum HcmFilingStatus {
  NOT_FILED = 'NOT_FILED',
  PENDING = 'PENDING',
  CONFIRMED = 'CONFIRMED',
  FAILED = 'FAILED',
}

/**
 * Append-only ledger entry types. The ledger is the auditable source of every change to a balance
 * and is the primary tool used by the test-suite to assert balance integrity.
 */
export enum LedgerEntryType {
  HOLD = 'HOLD', // available balance reserved by a PENDING request
  RELEASE = 'RELEASE', // a hold was released (reject / cancel-before-filing / HCM refusal)
  DEBIT = 'DEBIT', // a hold was converted to a confirmed HCM debit
  CREDIT = 'CREDIT', // balance added back (cancellation refund)
  ACCRUAL = 'ACCRUAL', // balance granted by the HCM (anniversary bonus / yearly refresh)
  RECONCILE = 'RECONCILE', // balance reset to the HCM authoritative snapshot
  DISCREPANCY = 'DISCREPANCY', // reconciliation detected an unexplained drift (flag, no auto-fix)
}

/** Where a ledger entry originated. */
export enum LedgerSource {
  EMPLOYEE_REQUEST = 'EMPLOYEE_REQUEST',
  MANAGER_DECISION = 'MANAGER_DECISION',
  HCM_REALTIME = 'HCM_REALTIME',
  HCM_BATCH = 'HCM_BATCH',
  RECONCILER = 'RECONCILER',
  SYSTEM = 'SYSTEM',
}

/** State of a transactional-outbox item that drives async filing to the HCM. */
export enum OutboxStatus {
  PENDING = 'PENDING', // ready to be sent
  RETRY = 'RETRY', // transient failure, will be retried after nextAttemptAt
  SENT = 'SENT', // successfully delivered & applied
  FAILED = 'FAILED', // HCM business refusal (terminal, no retry)
  DEAD = 'DEAD', // exhausted retries (terminal, needs manual / reconciliation)
  CANCELLED = 'CANCELLED', // superseded before it was sent (e.g. request cancelled while pending)
}

/** The operation an outbox item represents against the HCM realtime API. */
export enum OutboxOperation {
  FILE_DEBIT = 'FILE_DEBIT', // file a negative delta (consume balance)
  FILE_CREDIT = 'FILE_CREDIT', // file a positive delta (refund balance)
}
