import { INestApplication } from '@nestjs/common';
import { client } from '../helpers/client';
import { startMockHcm, RunningMockHcm } from '../helpers/mock-hcm-server';
import { createTestApp } from '../helpers/test-app';

describe('Time-off request lifecycle (e2e)', () => {
  let app: INestApplication;
  let hcm: RunningMockHcm;
  let api: ReturnType<typeof client>;

  beforeEach(async () => {
    hcm = await startMockHcm();
    hcm.state.set('emp-1', 'loc-1', 'ANNUAL', 10);
    ({ app } = await createTestApp({ hcmBaseUrl: hcm.baseUrl }));
    api = client(app);
  });

  afterEach(async () => {
    await app.close();
    await hcm.close();
  });

  const base = { employeeId: 'emp-1', locationId: 'loc-1', startDate: '2026-07-01', endDate: '2026-07-03' }; // 3 days

  it('create -> approve -> file: holds then confirms a debit against the HCM', async () => {
    const created = await api.create(base).expect(201);
    expect(created.body).toMatchObject({ status: 'PENDING', numberOfDays: 3, hcmFilingStatus: 'NOT_FILED' });

    // Local hold is visible instantly.
    let bal = await api.balance('emp-1', 'loc-1').expect(200);
    expect(bal.body).toMatchObject({ balanceDays: 10, pendingDays: 3, availableDays: 7 });

    await api.approve(created.body.id).expect(200);

    // Approval enqueues the HCM filing but does not confirm it yet.
    let req = await api.getRequest(created.body.id).expect(200);
    expect(req.body).toMatchObject({ status: 'APPROVED', hcmFilingStatus: 'PENDING' });

    const summary = await api.processOutbox().expect(200);
    expect(summary.body).toMatchObject({ sent: 1 });

    req = await api.getRequest(created.body.id).expect(200);
    expect(req.body).toMatchObject({ status: 'APPROVED', hcmFilingStatus: 'CONFIRMED' });
    expect(req.body.hcmReference).toMatch(/^HCM-/);

    // Hold converted to a confirmed debit; the HCM balance dropped to 7.
    bal = await api.balance('emp-1', 'loc-1').expect(200);
    expect(bal.body).toMatchObject({ balanceDays: 7, pendingDays: 0, availableDays: 7 });
    expect(hcm.state.get('emp-1', 'loc-1', 'ANNUAL')).toBe(7);
  });

  it('reject: releases the held balance and never touches the HCM', async () => {
    const created = await api.create(base).expect(201);
    await api.reject(created.body.id, { approverId: 'mgr-1', reason: 'blackout period' }).expect(200);

    const req = await api.getRequest(created.body.id).expect(200);
    expect(req.body).toMatchObject({ status: 'REJECTED', decisionReason: 'blackout period' });

    const bal = await api.balance('emp-1', 'loc-1').expect(200);
    expect(bal.body).toMatchObject({ pendingDays: 0, availableDays: 10 });
    expect(hcm.state.get('emp-1', 'loc-1', 'ANNUAL')).toBe(10); // untouched
  });

  it('cancel while PENDING: releases the hold', async () => {
    const created = await api.create(base).expect(201);
    await api.cancel(created.body.id, { actorId: 'emp-1' }).expect(200);

    const req = await api.getRequest(created.body.id).expect(200);
    expect(req.body.status).toBe('CANCELLED');
    const bal = await api.balance('emp-1', 'loc-1').expect(200);
    expect(bal.body.availableDays).toBe(10);
  });

  it('cancel after the HCM debit is confirmed: files a compensating refund', async () => {
    const created = await api.create(base).expect(201);
    await api.approve(created.body.id).expect(200);
    await api.processOutbox().expect(200); // confirm debit -> HCM = 7
    expect(hcm.state.get('emp-1', 'loc-1', 'ANNUAL')).toBe(7);

    await api.cancel(created.body.id, { reason: 'plans changed' }).expect(200);
    let req = await api.getRequest(created.body.id).expect(200);
    expect(req.body.status).toBe('CANCELLED');
    expect(req.body.hcmFilingStatus).toBe('PENDING'); // refund queued

    await api.processOutbox().expect(200); // file the credit -> HCM = 10
    req = await api.getRequest(created.body.id).expect(200);
    expect(req.body.hcmFilingStatus).toBe('CONFIRMED');

    const bal = await api.balance('emp-1', 'loc-1').expect(200);
    expect(bal.body.balanceDays).toBe(10);
    expect(hcm.state.get('emp-1', 'loc-1', 'ANNUAL')).toBe(10); // fully refunded
  });

  it('cancel after approve but before the filing is delivered: withdraws it and releases the hold', async () => {
    const created = await api.create(base).expect(201);
    await api.approve(created.body.id).expect(200);
    // Cancel while the outbox filing is still PENDING (not processed yet).
    await api.cancel(created.body.id, { reason: 'too soon' }).expect(200);

    const req = await api.getRequest(created.body.id).expect(200);
    expect(req.body.status).toBe('CANCELLED');

    // The queued filing was withdrawn — processing does nothing and the HCM is untouched.
    const summary = await api.processOutbox().expect(200);
    expect(summary.body.sent).toBe(0);
    expect(hcm.state.get('emp-1', 'loc-1', 'ANNUAL')).toBe(10);

    const bal = await api.balance('emp-1', 'loc-1').expect(200);
    expect(bal.body.availableDays).toBe(10);

    const cancelled = await api.listOutbox('CANCELLED').expect(200);
    expect(cancelled.body).toHaveLength(1);
  });

  it('rejects cancelling a terminal (already-rejected) request', async () => {
    const created = await api.create(base).expect(201);
    await api.reject(created.body.id).expect(200);
    const res = await api.cancel(created.body.id).expect(409);
    expect(res.body.errorCode).toBe('INVALID_STATE_TRANSITION');
  });

  it('rejects invalid state transitions and unknown requests', async () => {
    const created = await api.create(base).expect(201);
    await api.approve(created.body.id).expect(200);

    // Approving an already-approved request is a conflict.
    const conflict = await api.approve(created.body.id).expect(409);
    expect(conflict.body).toMatchObject({ errorCode: 'INVALID_STATE_TRANSITION' });

    const missing = await api.getRequest('does-not-exist').expect(404);
    expect(missing.body).toMatchObject({ errorCode: 'REQUEST_NOT_FOUND' });
  });

  it('supports idempotent creation via the Idempotency-Key header', async () => {
    const first = await api.create(base, 'idem-key-1').expect(201);
    const second = await api.create(base, 'idem-key-1').expect(201);
    expect(second.body.id).toBe(first.body.id);

    // Balance held only once.
    const bal = await api.balance('emp-1', 'loc-1').expect(200);
    expect(bal.body.pendingDays).toBe(3);
  });
});
