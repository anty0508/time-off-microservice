import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import { toDimensions } from '../common/dimensions';
import { BalancesService } from './balances.service';
import { BalanceView } from './balance.view';
import { GetBalanceQueryDto } from './dto/get-balance.query';
import { ListBalancesQueryDto } from './dto/list-balances.query';

@Controller('v1/balances')
export class BalancesController {
  constructor(private readonly balances: BalancesService) {}

  /** List balances, optionally filtered by any of the dimensions. */
  @Get()
  list(@Query() query: ListBalancesQueryDto): Promise<BalanceView[]> {
    return this.balances.listBalanceViews(query);
  }

  /**
   * Get a single balance for (employeeId, locationId[, leaveType]).
   * `?refresh=true` pulls the latest figure from the HCM realtime API and seeds it locally.
   */
  @Get(':employeeId/:locationId')
  async getOne(
    @Param('employeeId') employeeId: string,
    @Param('locationId') locationId: string,
    @Query() query: GetBalanceQueryDto,
  ): Promise<BalanceView> {
    const dims = toDimensions({ employeeId, locationId, leaveType: query.leaveType });
    if (query.refresh) {
      await this.balances.ensureBalance(dims);
    }
    const view = await this.balances.getBalanceView(dims);
    if (!view) {
      throw new NotFoundException(
        `No balance for employee ${dims.employeeId} at location ${dims.locationId} (${dims.leaveType})`,
      );
    }
    return view;
  }
}
