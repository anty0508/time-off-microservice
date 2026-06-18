import { Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager, OptimisticLockVersionMismatchError } from 'typeorm';
import { ConcurrencyConflictException } from '../common/exceptions';

/**
 * Runs a unit of work inside a single DB transaction.
 *
 * Two layers of concurrency safety:
 *  1. An in-process mutex serializes write transactions. SQLite is a single-writer engine, so
 *     serializing here turns would-be "database is locked" / nested-transaction errors into clean,
 *     ordered execution — which is what makes balance reservations deterministic under load.
 *  2. Optimistic-locking retries (version column) remain as a backstop for correctness if this
 *     service is ever run as multiple processes against a shared database.
 *
 * No code path calls `run()` from inside another `run()`, so the mutex cannot self-deadlock.
 */
@Injectable()
export class TransactionRunner {
  private readonly logger = new Logger(TransactionRunner.name);
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly dataSource: DataSource) {}

  run<T>(work: (manager: EntityManager) => Promise<T>, opts: { maxRetries?: number } = {}): Promise<T> {
    const exec = () => this.execute(work, opts);
    // Chain onto the tail regardless of whether the previous unit succeeded or failed.
    const result = this.tail.then(exec, exec);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async execute<T>(
    work: (manager: EntityManager) => Promise<T>,
    opts: { maxRetries?: number },
  ): Promise<T> {
    const maxRetries = opts.maxRetries ?? 5;
    let attempt = 0;

    for (;;) {
      try {
        return await this.dataSource.transaction(work);
      } catch (err) {
        if (this.isRetryable(err) && attempt < maxRetries) {
          attempt += 1;
          await this.backoff(attempt);
          this.logger.debug(`Retrying transaction (attempt ${attempt}/${maxRetries})`);
          continue;
        }
        if (this.isRetryable(err)) {
          throw new ConcurrencyConflictException({ attempts: attempt });
        }
        throw err;
      }
    }
  }

  private isRetryable(err: unknown): boolean {
    if (err instanceof OptimisticLockVersionMismatchError) return true;
    const message = (err as { message?: string })?.message ?? '';
    return /SQLITE_BUSY|database is locked|database table is locked|within a transaction/i.test(
      message,
    );
  }

  private async backoff(attempt: number): Promise<void> {
    const delayMs = Math.min(25 * 2 ** (attempt - 1), 250);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}
