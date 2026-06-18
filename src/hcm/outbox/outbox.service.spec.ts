import { DataSource } from 'typeorm';
import { toDimensions } from '../../common/dimensions';
import { OutboxOperation, OutboxStatus } from '../../common/enums';
import { ENTITIES, HcmOutbox } from '../../database/entities';
import { OutboxService } from './outbox.service';

describe('OutboxService (in-memory DB)', () => {
  let dataSource: DataSource;
  let outbox: OutboxService;
  const dims = toDimensions({ employeeId: 'e1', locationId: 'l1' });

  // Minimal ConfigService stub: maxAttempts = 3, retry base = 1ms.
  const config = {
    get: (key: string) =>
      key === 'hcm' ? { maxRetries: 3 } : { retryBaseMs: 1, batchSize: 25, pollIntervalMs: 2000 },
  };

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: ENTITIES,
      synchronize: true,
    });
    await dataSource.initialize();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    outbox = new OutboxService(dataSource.getRepository(HcmOutbox), config as any);
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  const enqueue = () =>
    dataSource.transaction((m) =>
      outbox.enqueue(m, {
        operation: OutboxOperation.FILE_DEBIT,
        requestId: 'r1',
        dims,
        deltaDays: -2,
      }),
    );

  it('enqueues a PENDING item that is immediately due', async () => {
    const item = await enqueue();
    expect(item.status).toBe(OutboxStatus.PENDING);
    expect(item.idempotencyKey).toBe('r1:FILE_DEBIT');
    expect(await outbox.claimDue(10)).toHaveLength(1);
  });

  it('retries with back-off then dead-letters after max attempts', async () => {
    let item = await enqueue();
    for (let i = 1; i <= 2; i++) {
      await dataSource.transaction(async (m) => {
        const fresh = await outbox.loadActive(m, item.id);
        await outbox.scheduleRetry(m, fresh!, 'boom');
      });
      item = await dataSource.getRepository(HcmOutbox).findOneByOrFail({ id: item.id });
      expect(item.status).toBe(OutboxStatus.RETRY);
      expect(item.attempts).toBe(i);
    }
    await dataSource.transaction(async (m) => {
      const fresh = await outbox.loadActive(m, item.id);
      await outbox.scheduleRetry(m, fresh!, 'boom');
    });
    item = await dataSource.getRepository(HcmOutbox).findOneByOrFail({ id: item.id });
    expect(item.status).toBe(OutboxStatus.DEAD);
  });

  it('cancels active items for a request', async () => {
    await enqueue();
    const cancelled = await dataSource.transaction((m) => outbox.cancelForRequest(m, 'r1'));
    expect(cancelled).toBe(1);
    expect(await outbox.claimDue(10, true)).toHaveLength(0);
  });

  it('loadActive returns null once an item is terminal', async () => {
    const item = await enqueue();
    await dataSource.transaction(async (m) => {
      const fresh = await outbox.loadActive(m, item.id);
      await outbox.markSent(m, fresh!, 'HCM-1');
    });
    expect(await dataSource.transaction((m) => outbox.loadActive(m, item.id))).toBeNull();
  });
});
