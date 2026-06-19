import { createMockHcm } from './mock-hcm.app';

/**
 * Standalone entrypoint so the mock HCM can be "deployed" / run independently:
 *   npm run mock:hcm
 */
async function bootstrap(): Promise<void> {
  const port = parseInt(process.env.MOCK_HCM_PORT ?? '4000', 10);
  const { app, state } = await createMockHcm();

  // Seed a little data so the server is immediately useful for manual exploration.
  state.set('emp-1', 'loc-us', 'ANNUAL', 10);
  state.set('emp-2', 'loc-eu', 'ANNUAL', 20);

  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`Mock HCM listening on http://localhost:${port}`);
}

void bootstrap();
