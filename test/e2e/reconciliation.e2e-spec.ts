import { INestApplication } from '@nestjs/common';
import { client, sleep } from '../helpers/client';
import { startMockHcm, RunningMockHcm } from '../helpers/mock-hcm-server';
import { createTestApp } from '../helpers/test-app';

describe('HCM reconciliation & independent balance changes (e2e)', () => {
  let app: INestApplication;
  let hcm: RunningMockHcm;
  let api: ReturnType<typeof client>;

  beforeEach(async () => {
    hcm = await startMockHcm();
    ({ app } = await createTestApp({ hcmBaseUrl: hcm.baseUrl }));
    api = client(app);
  });

  afterEach(async () => {
    await app.close();
    await hcm.close();
  });

  it('accepts a work-anniversary bonus applied independently at the HCM', async () => {
    hcm.state.set('emp-1', 'loc-1', 'ANNUAL', 10);
    await api.sync().expect(200);
    expect((await api.balance('emp-1', 'loc-1')).body.balanceDays).toBe(10);

    // The HCM grants a +5 anniversary bonus out-of-band.
    hcm.state.applyDelta('emp-1', 'loc-1', 'ANNUAL', 5);
    await sleep(10);
    const summary = await api.sync().expect(200);
    expect(summary.body.applied).toBeGreaterThanOrEqual(1);
    expect((await api.balance('emp-1', 'loc-1')).body.balanceDays).toBe(15);
  });

  it('applies a start-of-year refresh across buckets', async () => {
    hcm.state.set('emp-1', 'loc-1', 'ANNUAL', 3);
    hcm.state.set('emp-2', 'loc-2', 'ANNUAL', 4);
    await api.sync().expect(200);
    await sleep(10);

    // Yearly refresh: everyone reset to 25 at the HCM.
    hcm.state.set('emp-1', 'loc-1', 'ANNUAL', 25);
    hcm.state.set('emp-2', 'loc-2', 'ANNUAL', 25);
    await api.sync().expect(200);

    expect((await api.balance('emp-1', 'loc-1')).body.balanceDays).toBe(25);
    expect((await api.balance('emp-2', 'loc-2')).body.balanceDays).toBe(25);
  });

  it('ingests a single realtime balance push (webhook)', async () => {
    await api
      .webhook({ balances: [{ employeeId: 'emp-9', locationId: 'loc-9', balanceDays: 1 }] })
      .expect(200);
    // "1 day for locationId X for employeeId Y"
    expect((await api.balance('emp-9', 'loc-9')).body.balanceDays).toBe(1);
  });

  it('ignores a stale snapshot delivered out of order', async () => {
    await api
      .webhook({
        generatedAt: '2026-06-18T12:00:00.000Z',
        balances: [{ employeeId: 'emp-1', locationId: 'loc-1', balanceDays: 20 }],
      })
      .expect(200);

    const summary = await api
      .webhook({
        generatedAt: '2026-06-18T10:00:00.000Z', // older than what we already applied
        balances: [{ employeeId: 'emp-1', locationId: 'loc-1', balanceDays: 5 }],
      })
      .expect(200);

    expect(summary.body.skipped).toBe(1);
    expect((await api.balance('emp-1', 'loc-1')).body.balanceDays).toBe(20);
  });

  it('preserves consumed balance when a snapshot predates a confirmed debit (timing window)', async () => {
    hcm.state.set('emp-1', 'loc-1', 'ANNUAL', 10);
    const created = await api
      .create({ employeeId: 'emp-1', locationId: 'loc-1', startDate: '2026-07-01', endDate: '2026-07-04' }) // 4 days
      .expect(201);
    await api.approve(created.body.id).expect(200);

    await sleep(50);
    const midpoint = new Date().toISOString(); // after seeding, before the debit is filed
    await sleep(50);

    await api.processOutbox().expect(200); // debit -4 confirmed -> HCM = 6, local = 6
    expect((await api.balance('emp-1', 'loc-1')).body.balanceDays).toBe(6);

    // A *stale* batch (generated at `midpoint`, showing the pre-debit 10) must NOT refund us.
    // Naive reconciliation would reset to 10; the ledger-based adjustment keeps it at 6.
    await api
      .webhook({
        generatedAt: midpoint,
        balances: [{ employeeId: 'emp-1', locationId: 'loc-1', balanceDays: 10 }],
      })
      .expect(200);

    expect((await api.balance('emp-1', 'loc-1')).body.balanceDays).toBe(6);
  });

  it('detects (but does not silently mutate) an over-committed bucket', async () => {
    hcm.state.set('emp-1', 'loc-1', 'ANNUAL', 10);
    // Hold 8 days locally (still PENDING, not filed).
    await api
      .create({ employeeId: 'emp-1', locationId: 'loc-1', startDate: '2026-07-01', endDate: '2026-07-08' }) // 8 days
      .expect(201);
    await sleep(10);

    // The HCM independently drops the balance to 5 (e.g. correction by another system).
    hcm.state.set('emp-1', 'loc-1', 'ANNUAL', 5);
    const summary = await api
      .webhook({ balances: [{ employeeId: 'emp-1', locationId: 'loc-1', balanceDays: 5 }] })
      .expect(200);

    expect(summary.body.overcommitted).toBe(1);
    const bal = (await api.balance('emp-1', 'loc-1')).body;
    expect(bal).toMatchObject({ balanceDays: 5, pendingDays: 8, availableDays: -3 });
  });
});
