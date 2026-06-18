import { INestApplication } from '@nestjs/common';
import { client } from '../helpers/client';
import { startMockHcm, RunningMockHcm } from '../helpers/mock-hcm-server';
import { createTestApp } from '../helpers/test-app';

describe('Balance integrity & defensive validation (e2e)', () => {
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

  it('refuses a request that exceeds the available balance', async () => {
    hcm.state.set('emp-1', 'loc-1', 'ANNUAL', 2);
    const res = await api
      .create({ employeeId: 'emp-1', locationId: 'loc-1', startDate: '2026-07-01', endDate: '2026-07-03' })
      .expect(422);
    expect(res.body).toMatchObject({ errorCode: 'INSUFFICIENT_BALANCE' });
    expect(res.body.details).toMatchObject({ requested: 3, available: 2 });
  });

  it('refuses an unknown (invalid) dimension combination', async () => {
    const res = await api
      .create({ employeeId: 'ghost', locationId: 'nowhere', startDate: '2026-07-01', endDate: '2026-07-01' })
      .expect(422);
    expect(res.body).toMatchObject({ errorCode: 'INVALID_DIMENSION' });
  });

  it('is defensive: prevents an over-draw locally even when the HCM would NOT enforce it', async () => {
    // The HCM is misconfigured to accept any filing (the assessment warns this is not guaranteed).
    hcm.state.set('emp-1', 'loc-1', 'ANNUAL', 3);
    hcm.state.setConfig({ enforceBalance: false, enforceDimensions: false });

    const res = await api
      .create({ employeeId: 'emp-1', locationId: 'loc-1', startDate: '2026-07-01', endDate: '2026-07-05' }) // 5 days
      .expect(422);
    expect(res.body.errorCode).toBe('INSUFFICIENT_BALANCE');

    // Crucially, no over-draw ever reached the HCM — our local guard stopped it first.
    expect(hcm.state.get('emp-1', 'loc-1', 'ANNUAL')).toBe(3);
  });

  it('validates the request payload (bad date format -> 400 VALIDATION_ERROR)', async () => {
    const res = await api
      .create({ employeeId: 'emp-1', locationId: 'loc-1', startDate: '07/01/2026', endDate: '2026-07-03' })
      .expect(400);
    expect(res.body.errorCode).toBe('VALIDATION_ERROR');
  });

  it('rejects an end date before the start date', async () => {
    hcm.state.set('emp-1', 'loc-1', 'ANNUAL', 10);
    const res = await api
      .create({ employeeId: 'emp-1', locationId: 'loc-1', startDate: '2026-07-05', endDate: '2026-07-01' })
      .expect(400);
    expect(res.body.message).toMatch(/must not be before/);
  });

  it('keeps the available balance consistent across a mix of operations', async () => {
    hcm.state.set('emp-1', 'loc-1', 'ANNUAL', 10);
    // Hold 3 (pending), hold 2 (pending) -> available 5
    const a = await api.create({ employeeId: 'emp-1', locationId: 'loc-1', startDate: '2026-07-01', endDate: '2026-07-03' }).expect(201);
    await api.create({ employeeId: 'emp-1', locationId: 'loc-1', startDate: '2026-07-10', endDate: '2026-07-11' }).expect(201);

    let bal = await api.balance('emp-1', 'loc-1').expect(200);
    expect(bal.body).toMatchObject({ pendingDays: 5, availableDays: 5 });

    // Approve+confirm the first (3) -> balance 7, pending 2, available 5
    await api.approve(a.body.id).expect(200);
    await api.processOutbox().expect(200);
    bal = await api.balance('emp-1', 'loc-1').expect(200);
    expect(bal.body).toMatchObject({ balanceDays: 7, pendingDays: 2, availableDays: 5 });
  });
});
