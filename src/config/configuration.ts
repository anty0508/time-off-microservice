/** Strongly-typed application configuration, loaded from environment variables. */
export interface AppConfig {
  port: number;
  databasePath: string;
  hcm: {
    baseUrl: string;
    timeoutMs: number;
    maxRetries: number;
  };
  outbox: {
    pollIntervalMs: number;
    retryBaseMs: number;
    batchSize: number;
  };
  reconcile: {
    cron: string;
  };
  disableSchedulers: boolean;
}

function int(value: string | undefined, fallback: number): number {
  const n = parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

function bool(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

export default (): AppConfig => ({
  port: int(process.env.PORT, 3000),
  databasePath: process.env.DATABASE_PATH || './data/time-off.sqlite',
  hcm: {
    baseUrl: process.env.HCM_BASE_URL || 'http://localhost:4000',
    timeoutMs: int(process.env.HCM_TIMEOUT_MS, 5000),
    maxRetries: int(process.env.HCM_MAX_RETRIES, 5),
  },
  outbox: {
    pollIntervalMs: int(process.env.OUTBOX_POLL_INTERVAL_MS, 2000),
    retryBaseMs: int(process.env.OUTBOX_RETRY_BASE_MS, 1000),
    batchSize: int(process.env.OUTBOX_BATCH_SIZE, 25),
  },
  reconcile: {
    cron: process.env.RECONCILE_CRON || '*/5 * * * *',
  },
  disableSchedulers: bool(process.env.DISABLE_SCHEDULERS, false),
});
