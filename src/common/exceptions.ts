import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Stable, machine-readable error codes returned in API error bodies. Clients (the ExampleHR UI)
 * branch on these rather than on human-readable messages.
 */
export enum DomainErrorCode {
  INSUFFICIENT_BALANCE = 'INSUFFICIENT_BALANCE',
  INVALID_DIMENSION = 'INVALID_DIMENSION',
  REQUEST_NOT_FOUND = 'REQUEST_NOT_FOUND',
  INVALID_STATE_TRANSITION = 'INVALID_STATE_TRANSITION',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  HCM_UNAVAILABLE = 'HCM_UNAVAILABLE',
  CONCURRENCY_CONFLICT = 'CONCURRENCY_CONFLICT',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
}

/** Base class so the exception filter can attach a stable `errorCode` to every domain error. */
export class DomainException extends HttpException {
  constructor(
    public readonly errorCode: DomainErrorCode,
    message: string,
    status: HttpStatus,
    public readonly details?: Record<string, unknown>,
  ) {
    super({ errorCode, message, details }, status);
  }
}

/** The employee/manager tried to consume more than the available (balance - holds). */
export class InsufficientBalanceException extends DomainException {
  constructor(details: { requested: number; available: number } & Record<string, unknown>) {
    super(
      DomainErrorCode.INSUFFICIENT_BALANCE,
      `Insufficient balance: requested ${details.requested} day(s) but only ${details.available} available`,
      HttpStatus.UNPROCESSABLE_ENTITY,
      details,
    );
  }
}

/** The (employeeId, locationId, leaveType) tuple is not a known/valid balance bucket. */
export class InvalidDimensionException extends DomainException {
  constructor(details: Record<string, unknown>) {
    super(
      DomainErrorCode.INVALID_DIMENSION,
      'Unknown balance for the given (employeeId, locationId, leaveType); the HCM has no such bucket',
      HttpStatus.UNPROCESSABLE_ENTITY,
      details,
    );
  }
}

export class RequestNotFoundException extends DomainException {
  constructor(id: string) {
    super(
      DomainErrorCode.REQUEST_NOT_FOUND,
      `Time-off request "${id}" was not found`,
      HttpStatus.NOT_FOUND,
      { id },
    );
  }
}

/** A lifecycle action is not allowed from the request's current status. */
export class InvalidStateTransitionException extends DomainException {
  constructor(details: { from: string; action: string } & Record<string, unknown>) {
    super(
      DomainErrorCode.INVALID_STATE_TRANSITION,
      `Cannot ${details.action} a request in status ${details.from}`,
      HttpStatus.CONFLICT,
      details,
    );
  }
}

/** Optimistic-concurrency conflict after exhausting retries. */
export class ConcurrencyConflictException extends DomainException {
  constructor(details?: Record<string, unknown>) {
    super(
      DomainErrorCode.CONCURRENCY_CONFLICT,
      'The balance was modified concurrently; please retry',
      HttpStatus.CONFLICT,
      details,
    );
  }
}
