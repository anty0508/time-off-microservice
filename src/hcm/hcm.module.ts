import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BalancesModule } from '../balances/balances.module';
import { DatabaseModule } from '../database/database.module';
import { HcmClientModule } from './hcm-client.module';
import { HcmController } from './hcm.controller';
import { OutboxModule } from './outbox/outbox.module';
import { OutboxProcessor } from './outbox/outbox.processor';
import { ReconciliationService } from './reconciliation/reconciliation.service';
import { SyncScheduler } from './sync.scheduler';

/**
 * The HCM synchronization layer: outbox delivery, reconciliation, the operational HTTP endpoints,
 * and the background scheduler. Depends on the balances layer and the HCM client; nothing here
 * depends on the time-off module, so the module graph stays acyclic.
 */
@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    BalancesModule,
    OutboxModule,
    HcmClientModule,
  ],
  controllers: [HcmController],
  providers: [ReconciliationService, OutboxProcessor, SyncScheduler],
  exports: [ReconciliationService, OutboxProcessor],
})
export class HcmModule {}
