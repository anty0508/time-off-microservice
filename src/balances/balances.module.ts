import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Balance } from '../database/entities';
import { HcmClientModule } from '../hcm/hcm-client.module';
import { LedgerModule } from '../ledger/ledger.module';
import { BalancesController } from './balances.controller';
import { BalancesService } from './balances.service';

@Module({
  imports: [TypeOrmModule.forFeature([Balance]), LedgerModule, HcmClientModule],
  controllers: [BalancesController],
  providers: [BalancesService],
  exports: [BalancesService],
})
export class BalancesModule {}
