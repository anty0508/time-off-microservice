import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AppConfig } from './config/configuration';
import { AllExceptionsFilter } from './common/all-exceptions.filter';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: false });

  // Strict input validation: reject unknown properties, coerce types via class-transformer.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  // Consistent error envelopes for every failure.
  app.useGlobalFilters(new AllExceptionsFilter());

  app.enableShutdownHooks();

  const config = app.get(ConfigService<AppConfig, true>);
  const port = config.get('port', { infer: true });
  await app.listen(port);

  Logger.log(`Time-Off Microservice listening on http://localhost:${port}`, 'Bootstrap');
}

void bootstrap();
