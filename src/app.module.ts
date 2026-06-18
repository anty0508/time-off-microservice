import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import configuration from './config/configuration';
import { AppController } from './app.controller';
import { DatabaseModule } from './database/database.module';
import { BalancesModule } from './balances/balances.module';
import { TimeOffModule } from './time-off/time-off.module';
import { HcmModule } from './hcm/hcm.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    ScheduleModule.forRoot(),
    DatabaseModule,
    BalancesModule,
    TimeOffModule,
    HcmModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
