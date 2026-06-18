import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HcmClient } from './hcm.client';

/**
 * Leaf module exposing just the HCM HTTP client. Kept dependency-free (no DB) so both the balances
 * layer and the sync layer can use it without creating a circular module graph.
 */
@Module({
  imports: [ConfigModule],
  providers: [HcmClient],
  exports: [HcmClient],
})
export class HcmClientModule {}
