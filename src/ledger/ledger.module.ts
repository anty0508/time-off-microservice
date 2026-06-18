import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BalanceLedger } from '../database/entities';
import { LedgerService } from './ledger.service';

@Module({
  imports: [TypeOrmModule.forFeature([BalanceLedger])],
  providers: [LedgerService],
  exports: [LedgerService],
})
export class LedgerModule {}
