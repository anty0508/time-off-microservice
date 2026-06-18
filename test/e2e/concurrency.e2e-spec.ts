import { INestApplication } from '@nestjs/common';
import { client } from '../helpers/client';
import { startMockHcm, RunningMockHcm } from '../helpers/mock-hcm-server';
import { createTestApp } from '../helpers/test-app';

describe('Concurrency & idempotency (e2e)', () => {
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

  it('never over-reserves when many requests race for the same balance', async () => {
    hcm.state.set('emp-1', 'loc-1', 'ANNUAL', 5);
    // Seed the local balance first so all racers see the same starting point.
    await api.sync().expect(200);

    // Fire 10 single-day requests concurrently against a balance of 5.
    const attempts = Array.from({ length: 10 }, (_, i) => {
      const day = String(i + 1).padStart(2, '0');
      return api
        .create({
          employeeId: 'emp-1',
          locationId: 'loc-1',
          startDate: `2026-08-${day}`,
          endDate: `2026-08-${day}`,
        })
        .then((r) => r.status);
    });
    const statuses = await Promise.all(attempts);

    const created = statuses.filter((s) => s === 201).length;
    const rejected = statuses.filter((s) => s === 422).length;

    // Exactly the balance worth of requests succeed; the rest are cleanly rejected.
    expect(created).toBe(5);
    expect(rejected).toBe(5);

    const bal = (await api.balance('emp-1', 'loc-1')).body;
    expect(bal).toMatchObject({ pendingDays: 5, availableDays: 0 });
    expect(bal.availableDays).toBeGreaterThanOrEqual(0); // never negative
  });

  it('deduplicates concurrent retries sharing an idempotency key', async () => {
    hcm.state.set('emp-1', 'loc-1', 'ANNUAL', 10);
    await api.sync().expect(200);

    const body = { employeeId: 'emp-1', locationId: 'loc-1', startDate: '2026-08-01', endDate: '2026-08-02' };
    const [a, b] = await Promise.all([api.create(body, 'k-1'), api.create(body, 'k-1')]);

    expect(a.body.id).toBe(b.body.id);
    // Held exactly once despite two concurrent calls.
    expect((await api.balance('emp-1', 'loc-1')).body.pendingDays).toBe(2);
  });
});
