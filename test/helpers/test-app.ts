import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { AllExceptionsFilter } from '../../src/common/all-exceptions.filter';

export interface TestApp {
  app: INestApplication;
  moduleRef: TestingModule;
}

/**
 * Boot a full Nest application wired to a fresh in-memory SQLite database and the given HCM base
 * URL, with the background schedulers disabled so the test drives outbox/reconcile deterministically
 * via the HTTP endpoints.
 */
export async function createTestApp(opts: { hcmBaseUrl: string }): Promise<TestApp> {
  process.env.DATABASE_PATH = ':memory:';
  process.env.HCM_BASE_URL = opts.hcmBaseUrl;
  process.env.DISABLE_SCHEDULERS = 'true';
  process.env.OUTBOX_RETRY_BASE_MS = '5';
  process.env.HCM_MAX_RETRIES = '5';
  process.env.HCM_TIMEOUT_MS = '2000';

  const moduleRef: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  return { app, moduleRef };
}
