import express, { Express, Request, Response } from 'express';
import { MockHcmState } from './mock-hcm.state';

export interface MockHcm {
  app: Express;
  state: MockHcmState;
}

function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

/**
 * Build the mock HCM Express app around a (possibly shared) state object. Returns both so tests can
 * drive scenarios either over HTTP (the realistic path) or by poking the state directly.
 */
export function createMockHcm(state: MockHcmState = new MockHcmState()): MockHcm {
  const app = express();
  app.use(express.json());

  // --- Realtime GET balance -------------------------------------------------
  app.get('/balances', async (req: Request, res: Response) => {
    await delay(state.config.latencyMs);
    const employeeId = String(req.query.employeeId ?? '');
    const locationId = String(req.query.locationId ?? '');
    const leaveType = state.norm(req.query.leaveType as string | undefined);
    const balanceDays = state.get(employeeId, locationId, leaveType);
    if (balanceDays === undefined) {
      return res.status(404).json({ errorCode: 'NOT_FOUND', message: 'No such balance bucket' });
    }
    return res.json({ employeeId, locationId, leaveType, balanceDays });
  });

  // --- Realtime POST a signed delta (file a time-off) -----------------------
  app.post('/time-off', async (req: Request, res: Response) => {
    await delay(state.config.latencyMs);
    const { employeeId, locationId, deltaDays, idempotencyKey } = req.body ?? {};
    const leaveType = state.norm(req.body?.leaveType);

    // Idempotent replay: return the original outcome without re-applying the delta.
    if (idempotencyKey) {
      const prior = state.getIdempotent(idempotencyKey);
      if (prior) return res.json(prior);
    }

    // Forced failure injection (transient or business) for retry/error testing.
    if (state.config.failNext > 0) {
      state.setConfig({ failNext: state.config.failNext - 1 });
      if (state.config.failMode === 'transient') {
        return res.status(503).json({ errorCode: 'HCM_UNAVAILABLE', message: 'Simulated outage' });
      }
      return res
        .status(422)
        .json({ errorCode: 'SIMULATED_REJECTION', message: 'Simulated business rejection' });
    }

    if (typeof deltaDays !== 'number' || Number.isNaN(deltaDays)) {
      return res.status(400).json({ errorCode: 'BAD_REQUEST', message: 'deltaDays must be a number' });
    }

    const known = state.has(employeeId, locationId, leaveType);
    if (!known && state.config.enforceDimensions) {
      return res
        .status(422)
        .json({ errorCode: 'INVALID_DIMENSION', message: 'Unknown dimension combination' });
    }

    const current = state.get(employeeId, locationId, leaveType) ?? 0;
    if (state.config.enforceBalance && current + deltaDays < 0) {
      return res
        .status(422)
        .json({ errorCode: 'INSUFFICIENT_BALANCE', message: 'Filing would over-draw balance' });
    }

    const balanceDays = state.applyDelta(employeeId, locationId, leaveType, deltaDays);
    const reference = state.nextReference();
    if (idempotencyKey) state.rememberIdempotent(idempotencyKey, reference, balanceDays);
    return res.json({ reference, balanceDays });
  });

  // --- Batch corpus ---------------------------------------------------------
  app.get('/batch/balances', (_req: Request, res: Response) => {
    res.json({ generatedAt: new Date().toISOString(), balances: state.corpus() });
  });

  // --- Admin / simulation ---------------------------------------------------
  app.post('/admin/seed', (req: Request, res: Response) => {
    const entries = (req.body?.entries ?? []) as Array<{
      employeeId: string;
      locationId: string;
      leaveType?: string;
      balanceDays: number;
    }>;
    for (const e of entries) {
      state.set(e.employeeId, e.locationId, state.norm(e.leaveType), e.balanceDays);
    }
    res.json({ ok: true, count: entries.length });
  });

  // Simulate a work-anniversary bonus: an independent positive change at the HCM.
  app.post('/admin/anniversary', (req: Request, res: Response) => {
    const { employeeId, locationId, bonusDays } = req.body ?? {};
    const leaveType = state.norm(req.body?.leaveType);
    const balanceDays = state.applyDelta(employeeId, locationId, leaveType, Number(bonusDays) || 0);
    res.json({ employeeId, locationId, leaveType, balanceDays });
  });

  // Simulate a start-of-year refresh: set known buckets (or provided entries) to a value.
  app.post('/admin/yearly-refresh', (req: Request, res: Response) => {
    const { balanceDays } = req.body ?? {};
    if (typeof balanceDays === 'number') {
      for (const b of state.corpus()) {
        state.set(b.employeeId, b.locationId, b.leaveType, balanceDays);
      }
    }
    res.json({ ok: true, balances: state.corpus() });
  });

  app.post('/admin/config', (req: Request, res: Response) => {
    state.setConfig(req.body ?? {});
    res.json({ ok: true, config: state.config });
  });

  app.post('/admin/reset', (_req: Request, res: Response) => {
    state.reset();
    res.json({ ok: true });
  });

  app.get('/admin/state', (_req: Request, res: Response) => {
    res.json({ config: state.config, balances: state.corpus() });
  });

  return { app, state };
}
