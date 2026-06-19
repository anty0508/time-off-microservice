import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  Query,
} from '@nestjs/common';
import { MockHcmConfig, MockHcmState } from './mock-hcm.state';

function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

interface SeedEntry {
  employeeId: string;
  locationId: string;
  leaveType?: string;
  balanceDays: number;
}

/**
 * Mock HCM as a NestJS controller (same framework as the service under test). It mirrors the
 * external HCM's HTTP contract so tests can drive scenarios either over HTTP (the realistic path)
 * or by poking the injected MockHcmState directly. Error bodies use the { errorCode, message }
 * shape and the status codes that HcmClient classifies into transient vs business failures.
 */
@Controller()
export class MockHcmController {
  constructor(private readonly state: MockHcmState) {}

  // --- Realtime GET balance -------------------------------------------------
  @Get('balances')
  async getBalance(
    @Query('employeeId') employeeIdRaw?: string,
    @Query('locationId') locationIdRaw?: string,
    @Query('leaveType') leaveTypeRaw?: string,
  ) {
    await delay(this.state.config.latencyMs);
    const employeeId = String(employeeIdRaw ?? '');
    const locationId = String(locationIdRaw ?? '');
    const leaveType = this.state.norm(leaveTypeRaw);
    const balanceDays = this.state.get(employeeId, locationId, leaveType);
    if (balanceDays === undefined) {
      throw new HttpException(
        { errorCode: 'NOT_FOUND', message: 'No such balance bucket' },
        HttpStatus.NOT_FOUND,
      );
    }
    return { employeeId, locationId, leaveType, balanceDays };
  }

  // --- Realtime POST a signed delta (file a time-off) -----------------------
  @Post('time-off')
  @HttpCode(HttpStatus.OK)
  async fileTimeOff(@Body() body: Record<string, unknown> = {}) {
    await delay(this.state.config.latencyMs);
    const employeeId = body.employeeId as string;
    const locationId = body.locationId as string;
    const deltaDays = body.deltaDays as number;
    const idempotencyKey = body.idempotencyKey as string | undefined;
    const leaveType = this.state.norm(body.leaveType as string | undefined);

    // Idempotent replay: return the original outcome without re-applying the delta.
    if (idempotencyKey) {
      const prior = this.state.getIdempotent(idempotencyKey);
      if (prior) return prior;
    }

    // Forced failure injection (transient or business) for retry/error testing.
    if (this.state.config.failNext > 0) {
      this.state.setConfig({ failNext: this.state.config.failNext - 1 });
      if (this.state.config.failMode === 'transient') {
        throw new HttpException(
          { errorCode: 'HCM_UNAVAILABLE', message: 'Simulated outage' },
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
      throw new HttpException(
        { errorCode: 'SIMULATED_REJECTION', message: 'Simulated business rejection' },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    if (typeof deltaDays !== 'number' || Number.isNaN(deltaDays)) {
      throw new HttpException(
        { errorCode: 'BAD_REQUEST', message: 'deltaDays must be a number' },
        HttpStatus.BAD_REQUEST,
      );
    }

    const known = this.state.has(employeeId, locationId, leaveType);
    if (!known && this.state.config.enforceDimensions) {
      throw new HttpException(
        { errorCode: 'INVALID_DIMENSION', message: 'Unknown dimension combination' },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const current = this.state.get(employeeId, locationId, leaveType) ?? 0;
    if (this.state.config.enforceBalance && current + deltaDays < 0) {
      throw new HttpException(
        { errorCode: 'INSUFFICIENT_BALANCE', message: 'Filing would over-draw balance' },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const balanceDays = this.state.applyDelta(employeeId, locationId, leaveType, deltaDays);
    const reference = this.state.nextReference();
    if (idempotencyKey) this.state.rememberIdempotent(idempotencyKey, reference, balanceDays);
    return { reference, balanceDays };
  }

  // --- Batch corpus ---------------------------------------------------------
  @Get('batch/balances')
  getBatchBalances() {
    return { generatedAt: new Date().toISOString(), balances: this.state.corpus() };
  }

  // --- Admin / simulation ---------------------------------------------------
  @Post('admin/seed')
  @HttpCode(HttpStatus.OK)
  seed(@Body() body: { entries?: SeedEntry[] } = {}) {
    const entries = body.entries ?? [];
    for (const e of entries) {
      this.state.set(e.employeeId, e.locationId, this.state.norm(e.leaveType), e.balanceDays);
    }
    return { ok: true, count: entries.length };
  }

  // Simulate a work-anniversary bonus: an independent positive change at the HCM.
  @Post('admin/anniversary')
  @HttpCode(HttpStatus.OK)
  anniversary(@Body() body: Record<string, unknown> = {}) {
    const employeeId = body.employeeId as string;
    const locationId = body.locationId as string;
    const leaveType = this.state.norm(body.leaveType as string | undefined);
    const balanceDays = this.state.applyDelta(
      employeeId,
      locationId,
      leaveType,
      Number(body.bonusDays) || 0,
    );
    return { employeeId, locationId, leaveType, balanceDays };
  }

  // Simulate a start-of-year refresh: set known buckets (or provided entries) to a value.
  @Post('admin/yearly-refresh')
  @HttpCode(HttpStatus.OK)
  yearlyRefresh(@Body() body: { balanceDays?: number } = {}) {
    const { balanceDays } = body;
    if (typeof balanceDays === 'number') {
      for (const b of this.state.corpus()) {
        this.state.set(b.employeeId, b.locationId, b.leaveType, balanceDays);
      }
    }
    return { ok: true, balances: this.state.corpus() };
  }

  @Post('admin/config')
  @HttpCode(HttpStatus.OK)
  setConfig(@Body() body: Partial<MockHcmConfig> = {}) {
    this.state.setConfig(body ?? {});
    return { ok: true, config: this.state.config };
  }

  @Post('admin/reset')
  @HttpCode(HttpStatus.OK)
  reset() {
    this.state.reset();
    return { ok: true };
  }

  @Get('admin/state')
  getState() {
    return { config: this.state.config, balances: this.state.corpus() };
  }
}
