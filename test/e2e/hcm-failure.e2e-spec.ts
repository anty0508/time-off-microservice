import { INestApplication } from '@nestjs/common';
import { client } from '../helpers/client';
import { startMockHcm, RunningMockHcm } from '../helpers/mock-hcm-server';
import { createTestApp } from '../helpers/test-app';

describe('HCM failure handling (e2e)', () => {
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

  const req = { employeeId: 'emp-1', locationId: 'loc-1', startDate: '2026-07-01', endDate: '2026-07-02' }; // 2 days

  it('retries a transient HCM failure and then succeeds (hold preserved meanwhile)', async () => {
    const created = await api.create(req).expect(201);
    await api.approve(created.body.id).expect(200);

    hcm.state.setConfig({ failNext: 1, failMode: 'transient' });

    // First attempt fails transiently -> item goes to RETRY, request stays APPROVED/PENDING.
    let summary = await api.processOutbox().expect(200);
    expect(summary.body).toMatchObject({ retried: 1, sent: 0 });
    let r = await api.getRequest(created.body.id);
    expect(r.body.hcmFilingStatus).toBe('PENDING');
    expect((await api.balance('emp-1', 'loc-1')).body.pendingDays).toBe(2); // hold still held

    // Second attempt succeeds.
    summary = await api.processOutbox().expect(200);
    expect(summary.body).toMatchObject({ sent: 1 });
    r = await api.getRequest(created.body.id);
    expect(r.body.hcmFilingStatus).toBe('CONFIRMED');
    expect((await api.balance('emp-1', 'loc-1')).body).toMatchObject({ balanceDays: 8, pendingDays: 0 });
  });

  it('dead-letters an item after exhausting retries (keeps the hold for manual handling)', async () => {
    const created = await api.create(req).expect(201);
    await api.approve(created.body.id).expect(200);

    hcm.state.setConfig({ failNext: 99, failMode: 'transient' }); // always fails

    // HCM_MAX_RETRIES = 5 in the test app -> 5 attempts then DEAD.
    for (let i = 0; i < 5; i++) {
      await api.processOutbox().expect(200);
    }

    const dead = await api.listOutbox('DEAD').expect(200);
    expect(dead.body).toHaveLength(1);
    // The hold is intentionally retained; the request is still APPROVED awaiting intervention.
    const r = await api.getRequest(created.body.id);
    expect(r.body.status).toBe('APPROVED');
    expect((await api.balance('emp-1', 'loc-1')).body.pendingDays).toBe(2);
  });

  it('on a business refusal: releases the hold, fails the request, and reconciles', async () => {
    // The HCM authoritatively rejects the filing (e.g. its balance already changed).
    hcm.state.setConfig({ failNext: 1, failMode: 'business' });

    const created = await api.create(req).expect(201);
    await api.approve(created.body.id).expect(200);
    const summary = await api.processOutbox().expect(200);
    expect(summary.body).toMatchObject({ failed: 1 });

    const r = await api.getRequest(created.body.id);
    expect(r.body).toMatchObject({ status: 'FAILED', hcmFilingStatus: 'FAILED' });
    expect(r.body.failureReason).toContain('SIMULATED_REJECTION');

    // Hold released; reconciliation pulled the authoritative figure (still 10).
    const bal = (await api.balance('emp-1', 'loc-1')).body;
    expect(bal).toMatchObject({ balanceDays: 10, pendingDays: 0, availableDays: 10 });

    const failed = await api.listOutbox('FAILED').expect(200);
    expect(failed.body).toHaveLength(1);
  });
});
