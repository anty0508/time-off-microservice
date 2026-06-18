import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HcmOutbox } from '../../database/entities';
import { OutboxService } from './outbox.service';

@Module({
  imports: [TypeOrmModule.forFeature([HcmOutbox]), ConfigModule],
  providers: [OutboxService],
  exports: [OutboxService],
})
export class OutboxModule {}
