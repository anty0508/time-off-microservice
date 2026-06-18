import { SyncScheduler } from './sync.scheduler';

interface CronLike {
  start: jest.Mock;
  stop: jest.Mock;
}

function makeRegistry() {
  let cron: CronLike | undefined;
  return {
    addInterval: jest.fn(),
    deleteInterval: jest.fn(),
    addCronJob: jest.fn((_name: string, job: CronLike) => {
      cron = job;
    }),
    getCronJob: jest.fn(() => cron),
    deleteCronJob: jest.fn(),
  };
}

function makeScheduler(
  disabled: boolean,
  registry: ReturnType<typeof makeRegistry>,
  processor: { processBatch: jest.Mock },
  reconciliation: { pullAndReconcile: jest.Mock },
): SyncScheduler {
  const config = {
    get: (key: string) => {
      if (key === 'disableSchedulers') return disabled;
      if (key === 'outbox') return { pollIntervalMs: 3_600_000 };
      return { cron: '* * * * *' };
    },
  };
  return new SyncScheduler(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    processor as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    reconciliation as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registry as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    config as any,
  );
}

describe('SyncScheduler', () => {
  let registry: ReturnType<typeof makeRegistry>;
  let processor: { processBatch: jest.Mock };
  let reconciliation: { pullAndReconcile: jest.Mock };

  beforeEach(() => {
    registry = makeRegistry();
    processor = { processBatch: jest.fn().mockResolvedValue({ claimed: 0 }) };
    reconciliation = { pullAndReconcile: jest.fn().mockResolvedValue({}) };
  });

  it('registers nothing when disabled', () => {
    const s = makeScheduler(true, registry, processor, reconciliation);
    s.onModuleInit();
    expect(registry.addInterval).not.toHaveBeenCalled();
    expect(registry.addCronJob).not.toHaveBeenCalled();
  });

  it('registers the outbox interval and reconcile cron when enabled', () => {
    const s = makeScheduler(false, registry, processor, reconciliation);
    s.onModuleInit();
    expect(registry.addInterval).toHaveBeenCalledWith('outbox-poll', expect.anything());
    expect(registry.addCronJob).toHaveBeenCalledWith('hcm-reconcile', expect.anything());
    s.onModuleDestroy(); // stops the real cron job + clears the interval registration
    expect(registry.deleteInterval).toHaveBeenCalledWith('outbox-poll');
    expect(registry.deleteCronJob).toHaveBeenCalledWith('hcm-reconcile');
  });

  it('runOutbox delegates to the processor and swallows errors', async () => {
    const s = makeScheduler(false, registry, processor, reconciliation);
    processor.processBatch.mockResolvedValueOnce({ claimed: 2, sent: 2 });
    await (s as unknown as { runOutbox: () => Promise<void> }).runOutbox();
    expect(processor.processBatch).toHaveBeenCalled();

    processor.processBatch.mockRejectedValueOnce(new Error('boom'));
    await expect(
      (s as unknown as { runOutbox: () => Promise<void> }).runOutbox(),
    ).resolves.toBeUndefined();
  });

  it('runReconcile delegates to reconciliation and swallows HCM outages', async () => {
    const s = makeScheduler(false, registry, processor, reconciliation);
    await (s as unknown as { runReconcile: () => Promise<void> }).runReconcile();
    expect(reconciliation.pullAndReconcile).toHaveBeenCalled();

    reconciliation.pullAndReconcile.mockRejectedValueOnce(new Error('HCM down'));
    await expect(
      (s as unknown as { runReconcile: () => Promise<void> }).runReconcile(),
    ).resolves.toBeUndefined();
  });
});
