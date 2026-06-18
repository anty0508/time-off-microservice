import { DataSource, EntityManager } from 'typeorm';
import { toDimensions } from '../common/dimensions';
import { LedgerEntryType, LedgerSource } from '../common/enums';
import { InsufficientBalanceException, InvalidDimensionException } from '../common/exceptions';
import { Balance, BalanceLedger, ENTITIES } from '../database/entities';
import { HcmClient } from '../hcm/hcm.client';
import { HcmTransientError } from '../hcm/hcm.types';
import { LedgerService } from '../ledger/ledger.service';
import { BalancesService } from './balances.service';
import { availableDays } from './balance.view';

describe('BalancesService (in-memory DB, mocked HCM)', () => {
  let dataSource: DataSource;
  let balances: BalancesService;
  let hcm: { getBalance: jest.Mock };
  const dims = toDimensions({ employeeId: 'e1', locationId: 'l1' });

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: ENTITIES,
      synchronize: true,
    });
    await dataSource.initialize();
    hcm = { getBalance: jest.fn() };
    balances = new BalancesService(
      dataSource.getRepository(Balance),
      new LedgerService(),
      hcm as unknown as HcmClient,
    );
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  const tx = <T>(work: (m: EntityManager) => Promise<T>): Promise<T> =>
    dataSource.transaction(work);

  async function seed(balanceDays: number): Promise<void> {
    await dataSource.getRepository(Balance).save({ ...dims, balanceDays, pendingDays: 0 });
  }

  async function reload(): Promise<Balance> {
    return dataSource.getRepository(Balance).findOneByOrFail(dims);
  }

  describe('ensureBalance / seeding', () => {
    it('seeds a balance lazily from the HCM the first time', async () => {
      hcm.getBalance.mockResolvedValue({ ...dims, balanceDays: 9 });
      const b = await balances.ensureBalance(dims);
      expect(b.balanceDays).toBe(9);
      expect(hcm.getBalance).toHaveBeenCalledTimes(1);
      await balances.ensureBalance(dims);
      expect(hcm.getBalance).toHaveBeenCalledTimes(1); // second call uses local row
    });

    it('rejects an unknown dimension the HCM does not recognise', async () => {
      hcm.getBalance.mockResolvedValue(null);
      await expect(balances.ensureBalance(dims)).rejects.toBeInstanceOf(InvalidDimensionException);
    });

    it('surfaces a transient HCM error during seeding (cannot validate the dimension)', async () => {
      hcm.getBalance.mockRejectedValue(new HcmTransientError('HCM unreachable'));
      await expect(balances.ensureBalance(dims)).rejects.toBeInstanceOf(HcmTransientError);
    });
  });

  describe('reserve / releaseHold', () => {
    it('holds available balance and exposes it as pending', async () => {
      await seed(10);
      await tx((m) => balances.reserve(m, dims, 3, 'r1'));
      const b = await reload();
      expect(b.pendingDays).toBe(3);
      expect(availableDays(b)).toBe(7);
    });

    it('refuses to over-draw available balance', async () => {
      await seed(2);
      await expect(tx((m) => balances.reserve(m, dims, 3, 'r1'))).rejects.toBeInstanceOf(
        InsufficientBalanceException,
      );
    });

    it('releases a hold back to available', async () => {
      await seed(10);
      await tx((m) => balances.reserve(m, dims, 4, 'r1'));
      await tx((m) =>
        balances.releaseHold(m, dims, 4, 'r1', LedgerSource.MANAGER_DECISION, 'rejected'),
      );
      const b = await reload();
      expect(b.pendingDays).toBe(0);
      expect(availableDays(b)).toBe(10);
    });
  });

  describe('confirmDebit / credit', () => {
    it('converts a hold into a confirmed debit', async () => {
      await seed(10);
      await tx((m) => balances.reserve(m, dims, 4, 'r1'));
      await tx((m) => balances.confirmDebit(m, dims, 4, 'r1'));
      const b = await reload();
      expect(b.balanceDays).toBe(6);
      expect(b.pendingDays).toBe(0);
    });

    it('credits a refund back to the authoritative balance', async () => {
      await seed(6);
      await tx((m) =>
        balances.credit(m, dims, 4, 'r1', LedgerSource.HCM_REALTIME, LedgerEntryType.CREDIT),
      );
      expect((await reload()).balanceDays).toBe(10);
    });
  });

  describe('applyHcmSnapshot (reconciliation)', () => {
    it('overwrites balance with the HCM figure but preserves local holds', async () => {
      await seed(10);
      await tx((m) => balances.reserve(m, dims, 3, 'r1')); // pending 3
      await tx((m) => balances.applyHcmSnapshot(m, dims, 15, new Date(), { hcmBalance: 15 }));
      const b = await reload();
      expect(b.balanceDays).toBe(15); // anniversary bonus accepted
      expect(b.pendingDays).toBe(3); // hold preserved
      expect(availableDays(b)).toBe(12);
    });

    it('ignores a stale snapshot (older asOf)', async () => {
      await seed(10);
      const newer = new Date('2026-06-18T12:00:00Z');
      const older = new Date('2026-06-18T10:00:00Z');
      await tx((m) => balances.applyHcmSnapshot(m, dims, 20, newer, {}));
      const res = await tx((m) => balances.applyHcmSnapshot(m, dims, 5, older, {}));
      expect(res.skipped).toBe(true);
      expect((await reload()).balanceDays).toBe(20);
    });

    it('flags an over-committed bucket without mutating holds', async () => {
      await seed(10);
      await tx((m) => balances.reserve(m, dims, 8, 'r1')); // pending 8
      const res = await tx((m) => balances.applyHcmSnapshot(m, dims, 5, new Date(), {}));
      expect(res.overcommitted).toBe(true);
      const b = await reload();
      expect(b.balanceDays).toBe(5);
      expect(b.pendingDays).toBe(8); // untouched
      expect(availableDays(b)).toBe(-3);
    });
  });

  describe('ledger integrity', () => {
    it('reconstructs the current balance by replaying ledger deltas', async () => {
      await seed(10);
      await tx((m) => balances.reserve(m, dims, 4, 'r1'));
      await tx((m) => balances.confirmDebit(m, dims, 4, 'r1'));
      await tx((m) =>
        balances.credit(m, dims, 1, 'r1', LedgerSource.HCM_REALTIME, LedgerEntryType.CREDIT),
      );

      const entries = await dataSource.getRepository(BalanceLedger).find({ where: dims });
      const balanceDeltaSum = entries.reduce((s, e) => s + e.balanceDelta, 0);
      const pendingDeltaSum = entries.reduce((s, e) => s + e.pendingDelta, 0);
      const b = await reload();
      // balance: 10 (seed) - 4 (debit) + 1 (credit) = 7; deltas on top of seed sum to -3.
      expect(10 + balanceDeltaSum).toBeCloseTo(b.balanceDays, 4);
      expect(pendingDeltaSum).toBeCloseTo(b.pendingDays, 4);
      expect(b.balanceDays).toBe(7);
    });
  });
});
