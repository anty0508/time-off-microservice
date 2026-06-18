import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v4 as uuid } from 'uuid';
import { BalancesService } from '../balances/balances.service';
import { toDimensions } from '../common/dimensions';
import { HcmFilingStatus, LedgerSource, OutboxOperation, RequestStatus } from '../common/enums';
import { inclusiveDayCount } from '../common/date.util';
import {
  InvalidStateTransitionException,
  RequestNotFoundException,
} from '../common/exceptions';
import { TransactionRunner } from '../database/transaction.runner';
import { TimeOffRequest } from '../database/entities';
import { OutboxService } from '../hcm/outbox/outbox.service';
import { CreateTimeOffRequestDto } from './dto/create-time-off-request.dto';
import { DecisionDto } from './dto/decision.dto';
import { CancelDto } from './dto/cancel.dto';
import { ListRequestsQueryDto } from './dto/list-requests.query';
import { RequestView, toRequestView } from './request.view';

/**
 * Orchestrates the full lifecycle of a time-off request while keeping the local balance consistent
 * with the HCM source of truth.
 *
 * The "instant feedback" the employee/manager needs is provided synchronously by holding/releasing
 * balance locally; the authoritative debit/credit against the HCM happens asynchronously and
 * reliably via the transactional outbox.
 */
@Injectable()
export class TimeOffService {
  private readonly logger = new Logger(TimeOffService.name);

  constructor(
    @InjectRepository(TimeOffRequest) private readonly requests: Repository<TimeOffRequest>,
    private readonly balances: BalancesService,
    private readonly outbox: OutboxService,
    private readonly tx: TransactionRunner,
  ) {}

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  async getById(id: string): Promise<RequestView> {
    const request = await this.requests.findOne({ where: { id } });
    if (!request) throw new RequestNotFoundException(id);
    return toRequestView(request);
  }

  async list(query: ListRequestsQueryDto): Promise<RequestView[]> {
    const where: Record<string, string> = {};
    if (query.employeeId) where.employeeId = query.employeeId;
    if (query.locationId) where.locationId = query.locationId;
    if (query.leaveType) where.leaveType = query.leaveType;
    if (query.status) where.status = query.status;
    const rows = await this.requests.find({ where, order: { createdAt: 'DESC' } });
    return rows.map(toRequestView);
  }

  // ---------------------------------------------------------------------------
  // Create (employee submits)
  // ---------------------------------------------------------------------------

  async create(dto: CreateTimeOffRequestDto, idempotencyKey?: string): Promise<RequestView> {
    const dims = toDimensions(dto);

    let numberOfDays: number;
    try {
      numberOfDays = inclusiveDayCount(dto.startDate, dto.endDate);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }

    // Fast path for idempotent retries: return the existing request without re-reserving balance.
    if (idempotencyKey) {
      const existing = await this.requests.findOne({ where: { idempotencyKey } });
      if (existing) return toRequestView(existing);
    }

    // Validate the dimension & seed the balance from the HCM if we've never seen it (network call
    // performed outside the transaction).
    await this.balances.ensureBalance(dims);

    const view = await this.tx.run(async (manager) => {
      if (idempotencyKey) {
        const existing = await manager.findOne(TimeOffRequest, { where: { idempotencyKey } });
        if (existing) return toRequestView(existing);
      }

      const request = manager.create(TimeOffRequest, {
        id: uuid(),
        ...dims,
        startDate: dto.startDate,
        endDate: dto.endDate,
        numberOfDays,
        status: RequestStatus.PENDING,
        hcmFilingStatus: HcmFilingStatus.NOT_FILED,
        reason: dto.reason ?? null,
        idempotencyKey: idempotencyKey ?? null,
      });
      await manager.save(request);

      // Hold balance — throws InsufficientBalanceException if it would over-draw.
      await this.balances.reserve(manager, dims, numberOfDays, request.id);

      return toRequestView(request);
    });

    return view;
  }

  // ---------------------------------------------------------------------------
  // Manager decisions
  // ---------------------------------------------------------------------------

  async approve(id: string, dto: DecisionDto): Promise<RequestView> {
    return this.tx.run(async (manager) => {
      const request = await this.loadRequest(manager, id);
      if (request.status !== RequestStatus.PENDING) {
        throw new InvalidStateTransitionException({ from: request.status, action: 'approve' });
      }
      request.status = RequestStatus.APPROVED;
      request.approverId = dto.approverId;
      request.decisionReason = dto.reason ?? null;
      request.hcmFilingStatus = HcmFilingStatus.PENDING;
      await manager.save(request);

      // Enqueue the authoritative debit; the outbox processor delivers it to the HCM with retries.
      await this.outbox.enqueue(manager, {
        operation: OutboxOperation.FILE_DEBIT,
        requestId: request.id,
        dims: toDimensions(request),
        deltaDays: -request.numberOfDays,
      });

      return toRequestView(request);
    });
  }

  async reject(id: string, dto: DecisionDto): Promise<RequestView> {
    return this.tx.run(async (manager) => {
      const request = await this.loadRequest(manager, id);
      if (request.status !== RequestStatus.PENDING) {
        throw new InvalidStateTransitionException({ from: request.status, action: 'reject' });
      }
      request.status = RequestStatus.REJECTED;
      request.approverId = dto.approverId;
      request.decisionReason = dto.reason ?? null;
      await manager.save(request);

      // Release the hold — nothing was ever filed with the HCM.
      await this.balances.releaseHold(
        manager,
        toDimensions(request),
        request.numberOfDays,
        request.id,
        LedgerSource.MANAGER_DECISION,
        dto.reason,
      );

      return toRequestView(request);
    });
  }

  // ---------------------------------------------------------------------------
  // Cancellation (employee or manager)
  // ---------------------------------------------------------------------------

  async cancel(id: string, dto: CancelDto): Promise<RequestView> {
    return this.tx.run(async (manager) => {
      const request = await this.loadRequest(manager, id);
      const dims = toDimensions(request);

      switch (request.status) {
        case RequestStatus.PENDING:
          // Never filed; just release the hold.
          await this.balances.releaseHold(
            manager,
            dims,
            request.numberOfDays,
            request.id,
            LedgerSource.EMPLOYEE_REQUEST,
            dto.reason,
          );
          request.status = RequestStatus.CANCELLED;
          request.decisionReason = dto.reason ?? null;
          break;

        case RequestStatus.APPROVED:
          await this.cancelApproved(manager, request, dto);
          break;

        default:
          throw new InvalidStateTransitionException({ from: request.status, action: 'cancel' });
      }

      await manager.save(request);
      return toRequestView(request);
    });
  }

  /** Cancel an already-approved request, depending on whether the HCM debit was filed yet. */
  private async cancelApproved(
    manager: import('typeorm').EntityManager,
    request: TimeOffRequest,
    dto: CancelDto,
  ): Promise<void> {
    const dims = toDimensions(request);

    if (request.hcmFilingStatus === HcmFilingStatus.PENDING) {
      // Filing not yet delivered — try to withdraw the outbox item before it is sent.
      const cancelled = await this.outbox.cancelForRequest(manager, request.id);
      if (cancelled > 0) {
        await this.balances.releaseHold(
          manager,
          dims,
          request.numberOfDays,
          request.id,
          LedgerSource.EMPLOYEE_REQUEST,
          dto.reason,
        );
        request.status = RequestStatus.CANCELLED;
        request.hcmFilingStatus = HcmFilingStatus.NOT_FILED;
        request.decisionReason = dto.reason ?? null;
        return;
      }
      // Otherwise the debit was delivered concurrently — fall through to the refund path.
    }

    if (request.hcmFilingStatus === HcmFilingStatus.CONFIRMED) {
      // Already debited at the HCM — enqueue a compensating credit (refund).
      request.status = RequestStatus.CANCELLED;
      request.hcmFilingStatus = HcmFilingStatus.PENDING;
      request.decisionReason = dto.reason ?? null;
      await this.outbox.enqueue(manager, {
        operation: OutboxOperation.FILE_CREDIT,
        requestId: request.id,
        dims,
        deltaDays: request.numberOfDays,
      });
      return;
    }

    // FAILED filing (hold already released) — cancellation is a no-op refund-wise.
    request.status = RequestStatus.CANCELLED;
    request.decisionReason = dto.reason ?? null;
  }

  private async loadRequest(
    manager: import('typeorm').EntityManager,
    id: string,
  ): Promise<TimeOffRequest> {
    const request = await manager.findOne(TimeOffRequest, { where: { id } });
    if (!request) throw new RequestNotFoundException(id);
    return request;
  }
}
