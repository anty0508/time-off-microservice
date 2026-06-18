import { DataSource, EntityManager, OptimisticLockVersionMismatchError } from 'typeorm';
import { ConcurrencyConflictException } from '../common/exceptions';
import { TransactionRunner } from './transaction.runner';

type TxFn = (work: (m: EntityManager) => Promise<unknown>) => Promise<unknown>;

function runnerWith(transaction: TxFn): TransactionRunner {
  return new TransactionRunner({ transaction } as unknown as DataSource);
}

describe('TransactionRunner', () => {
  it('runs work in a transaction and returns its result', async () => {
    const runner = runnerWith((work) => work({} as EntityManager));
    await expect(runner.run(async () => 42)).resolves.toBe(42);
  });

  it('retries a retryable error then succeeds', async () => {
    let calls = 0;
    const runner = runnerWith(async (work) => {
      calls += 1;
      if (calls === 1) throw new OptimisticLockVersionMismatchError('Balance', 1, 2);
      return work({} as EntityManager);
    });
    await expect(runner.run(async () => 'ok')).resolves.toBe('ok');
    expect(calls).toBe(2);
  });

  it('maps exhausted retries to a ConcurrencyConflictException', async () => {
    const runner = runnerWith(async () => {
      throw new Error('SQLITE_BUSY: database is locked');
    });
    await expect(runner.run(async () => 'x', { maxRetries: 1 })).rejects.toBeInstanceOf(
      ConcurrencyConflictException,
    );
  });

  it('propagates non-retryable errors unchanged', async () => {
    const runner = runnerWith((work) => work({} as EntityManager));
    await expect(
      runner.run(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });

  it('serializes transactions through the in-process mutex', async () => {
    let active = 0;
    const order: number[] = [];
    const runner = runnerWith((work) => work({} as EntityManager));
    const task = (n: number) =>
      runner.run(async () => {
        active += 1;
        expect(active).toBe(1); // never two at once
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
        order.push(n);
      });
    await Promise.all([task(1), task(2), task(3)]);
    expect(order).toEqual([1, 2, 3]); // FIFO order preserved
  });
});
