import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance, AxiosError } from 'axios';
import { AppConfig } from '../config/configuration';
import { BalanceDimensions } from '../common/dimensions';
import {
  HcmBalanceSnapshot,
  HcmBatchResponse,
  HcmBusinessError,
  HcmFileRequest,
  HcmFileResult,
  HcmTransientError,
} from './hcm.types';

/**
 * Thin, well-behaved client for the HCM system (mock or real Workday/SAP gateway).
 *
 * Responsibilities:
 *  - apply a request timeout to every call;
 *  - classify failures into BUSINESS (terminal) vs TRANSIENT (retryable) so callers/outbox can
 *    react correctly. This classification is the backbone of the system's defensiveness toward
 *    an HCM that "may not always" behave as documented.
 *
 * This module deliberately has no dependency on the database layer, so it can be imported by both
 * the balances layer (lazy seeding) and the sync layer (outbox/reconciliation) without cycles.
 */
@Injectable()
export class HcmClient {
  private readonly logger = new Logger(HcmClient.name);
  private readonly http: AxiosInstance;

  constructor(private readonly config: ConfigService<AppConfig, true>) {
    const hcm = this.config.get('hcm', { infer: true });
    this.http = axios.create({
      baseURL: hcm.baseUrl,
      timeout: hcm.timeoutMs,
      headers: { 'Content-Type': 'application/json' },
      // We classify status codes ourselves rather than letting axios throw on >=400.
      validateStatus: () => true,
    });
  }

  /** Realtime GET of a single balance. Returns null if the HCM has no such bucket (404). */
  async getBalance(dims: BalanceDimensions): Promise<HcmBalanceSnapshot | null> {
    try {
      const res = await this.http.get('/balances', { params: dims });
      if (res.status === 404) return null;
      if (res.status >= 400) throw this.toError(res.status, res.data);
      return res.data as HcmBalanceSnapshot;
    } catch (err) {
      throw this.normalize(err);
    }
  }

  /**
   * Realtime POST of a signed delta. The HCM is expected to validate (balance/dimension) and
   * return a reference, or reject with a business error. Idempotency-Key makes retries safe.
   */
  async fileTimeOff(req: HcmFileRequest): Promise<HcmFileResult> {
    try {
      const res = await this.http.post(
        '/time-off',
        {
          employeeId: req.dims.employeeId,
          locationId: req.dims.locationId,
          leaveType: req.dims.leaveType,
          deltaDays: req.deltaDays,
          requestId: req.requestId,
          idempotencyKey: req.idempotencyKey,
        },
        { headers: { 'Idempotency-Key': req.idempotencyKey } },
      );
      if (res.status >= 400) throw this.toError(res.status, res.data);
      return res.data as HcmFileResult;
    } catch (err) {
      throw this.normalize(err);
    }
  }

  /** Batch endpoint: returns the whole corpus of balances plus the snapshot generation time. */
  async getBatchBalances(): Promise<HcmBatchResponse> {
    try {
      const res = await this.http.get('/batch/balances');
      if (res.status >= 400) throw this.toError(res.status, res.data);
      return res.data as HcmBatchResponse;
    } catch (err) {
      throw this.normalize(err);
    }
  }

  /** Map an HTTP status + body into the appropriate typed error. */
  private toError(status: number, body: unknown): HcmBusinessError | HcmTransientError {
    if (this.isTransientStatus(status)) {
      return new HcmTransientError(`HCM transient failure (status ${status})`, status);
    }
    const b = (body ?? {}) as { errorCode?: string; code?: string; message?: string };
    return new HcmBusinessError(
      b.errorCode ?? b.code ?? 'HCM_BUSINESS_ERROR',
      b.message ?? `HCM rejected the request (status ${status})`,
      status,
    );
  }

  /** Normalize thrown values (axios network/timeout errors, our typed errors) into typed errors. */
  private normalize(err: unknown): HcmBusinessError | HcmTransientError {
    if (err instanceof HcmBusinessError || err instanceof HcmTransientError) return err;
    const axiosErr = err as AxiosError;
    if (axiosErr?.isAxiosError) {
      if (axiosErr.response) return this.toError(axiosErr.response.status, axiosErr.response.data);
      // No response => timeout / connection refused / DNS, etc. => transient.
      return new HcmTransientError(`HCM unreachable: ${axiosErr.code ?? axiosErr.message}`);
    }
    return new HcmTransientError(`HCM call failed: ${(err as Error)?.message ?? String(err)}`);
  }

  private isTransientStatus(status: number): boolean {
    return status >= 500 || status === 408 || status === 425 || status === 429;
  }
}
