import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { AppConfig } from '../config/configuration';
import { ENTITIES } from './entities';
import { TransactionRunner } from './transaction.runner';

/**
 * Configures TypeORM over SQLite (better-sqlite3 driver).
 *
 * `synchronize: true` auto-creates the schema from the entity metadata. This is appropriate for a
 * self-contained assessment / dev service; a production deployment would switch to versioned
 * migrations (called out in the TRD).
 */
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => {
        const databasePath = config.get('databasePath', { infer: true });
        if (databasePath !== ':memory:') {
          mkdirSync(dirname(databasePath), { recursive: true });
        }
        return {
          type: 'better-sqlite3',
          database: databasePath,
          entities: ENTITIES,
          synchronize: true,
          // SQLite is a single-writer engine; serialize writes and wait rather than failing fast.
          busyTimeout: 5000,
          enableWAL: databasePath !== ':memory:',
        };
      },
    }),
  ],
  providers: [TransactionRunner],
  exports: [TransactionRunner],
})
export class DatabaseModule {}
