import { Server } from 'http';
import { AddressInfo } from 'net';
import { createMockHcm } from '../mock-hcm/mock-hcm.app';
import { MockHcmState } from '../mock-hcm/mock-hcm.state';

export interface RunningMockHcm {
  baseUrl: string;
  state: MockHcmState;
  close: () => Promise<void>;
}

/** Start the mock HCM on an ephemeral port for an e2e test and return its base URL + state. */
export async function startMockHcm(): Promise<RunningMockHcm> {
  const { app, state } = createMockHcm();
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    state,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
