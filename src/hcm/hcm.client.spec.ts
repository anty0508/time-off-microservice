import { ConfigService } from '@nestjs/config';
import { startMockHcm, RunningMockHcm } from '../../test/helpers/mock-hcm-server';
import { toDimensions } from '../common/dimensions';
import { HcmClient } from './hcm.client';
import { HcmBusinessError, HcmTransientError } from './hcm.types';

function clientFor(baseUrl: string): HcmClient {
  const config = {
    get: () => ({ baseUrl, timeoutMs: 2000, maxRetries: 5 }),
  } as unknown as ConfigService<Record<string, unknown>, true>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new HcmClient(config as any);
}

describe('HcmClient (against the real mock HCM)', () => {
  let hcm: RunningMockHcm;
  let client: HcmClient;
  const dims = toDimensions({ employeeId: 'e1', locationId: 'l1' });

  beforeEach(async () => {
    hcm = await startMockHcm();
    client = clientFor(hcm.baseUrl);
  });

  afterEach(async () => {
    await hcm.close();
  });

  it('returns null for an unknown balance bucket (404)', async () => {
    expect(await client.getBalance(dims)).toBeNull();
  });

  it('reads a seeded balance', async () => {
    hcm.state.set('e1', 'l1', 'ANNUAL', 12);
    const snap = await client.getBalance(dims);
    expect(snap).toMatchObject({ employeeId: 'e1', locationId: 'l1', balanceDays: 12 });
  });

  it('files a debit and returns a reference', async () => {
    hcm.state.set('e1', 'l1', 'ANNUAL', 5);
    const result = await client.fileTimeOff({ dims, deltaDays: -2, requestId: 'r1', idempotencyKey: 'k1' });
    expect(result.reference).toMatch(/^HCM-/);
    expect(hcm.state.get('e1', 'l1', 'ANNUAL')).toBe(3);
  });

  it('is idempotent for a repeated idempotency key', async () => {
    hcm.state.set('e1', 'l1', 'ANNUAL', 5);
    const a = await client.fileTimeOff({ dims, deltaDays: -2, requestId: 'r1', idempotencyKey: 'k1' });
    const b = await client.fileTimeOff({ dims, deltaDays: -2, requestId: 'r1', idempotencyKey: 'k1' });
    expect(b.reference).toBe(a.reference);
    expect(hcm.state.get('e1', 'l1', 'ANNUAL')).toBe(3); // applied once
  });

  it('maps an over-draw to a terminal HcmBusinessError', async () => {
    hcm.state.set('e1', 'l1', 'ANNUAL', 1);
    await expect(
      client.fileTimeOff({ dims, deltaDays: -5, requestId: 'r1', idempotencyKey: 'k1' }),
    ).rejects.toBeInstanceOf(HcmBusinessError);
  });

  it('maps a 5xx to a retryable HcmTransientError', async () => {
    hcm.state.set('e1', 'l1', 'ANNUAL', 5);
    hcm.state.setConfig({ failNext: 1, failMode: 'transient' });
    await expect(
      client.fileTimeOff({ dims, deltaDays: -1, requestId: 'r1', idempotencyKey: 'k1' }),
    ).rejects.toBeInstanceOf(HcmTransientError);
  });

  it('maps connection failure to a transient error', async () => {
    const dead = clientFor('http://127.0.0.1:1');
    await expect(dead.getBatchBalances()).rejects.toBeInstanceOf(HcmTransientError);
  });

  it('returns the batch corpus', async () => {
    hcm.state.set('e1', 'l1', 'ANNUAL', 5);
    hcm.state.set('e2', 'l2', 'ANNUAL', 7);
    const batch = await client.getBatchBalances();
    expect(batch.balances).toHaveLength(2);
    expect(batch.generatedAt).toBeDefined();
  });
});
