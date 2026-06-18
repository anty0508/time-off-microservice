import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BalancesModule } from '../balances/balances.module';
import { DatabaseModule } from '../database/database.module';
import { TimeOffRequest } from '../database/entities';
import { OutboxModule } from '../hcm/outbox/outbox.module';
import { TimeOffController } from './time-off.controller';
import { TimeOffService } from './time-off.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([TimeOffRequest]),
    BalancesModule,
    OutboxModule,
    DatabaseModule,
  ],
  controllers: [TimeOffController],
  providers: [TimeOffService],
  exports: [TimeOffService],
})
export class TimeOffModule {}
