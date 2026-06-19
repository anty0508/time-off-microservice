import { DynamicModule, INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MockHcmController } from './mock-hcm.controller';
import { MockHcmState } from './mock-hcm.state';

export interface MockHcm {
  app: INestApplication;
  state: MockHcmState;
}

/**
 * NestJS module for the mock HCM. The (possibly shared) state is supplied as a value provider so
 * the controller and the test driving the scenario operate on the exact same instance.
 */
@Module({})
export class MockHcmModule {
  static register(state: MockHcmState): DynamicModule {
    return {
      module: MockHcmModule,
      controllers: [MockHcmController],
      providers: [{ provide: MockHcmState, useValue: state }],
    };
  }
}

/**
 * Build the mock HCM Nest app around a (possibly shared) state object. Returns both so tests can
 * drive scenarios either over HTTP (the realistic path) or by poking the state directly. The
 * returned app is created but NOT yet listening — the caller starts it with `await app.listen(...)`.
 */
export async function createMockHcm(state: MockHcmState = new MockHcmState()): Promise<MockHcm> {
  const app = await NestFactory.create(MockHcmModule.register(state), { logger: false });
  return { app, state };
}
