import { afterAll, afterEach, beforeAll } from 'vitest';
import { setupServer } from 'msw/node';

/** Keep each mocked exchange on its own connection, including requests aborted mid-response. */
export function providerServer() {
  const server = setupServer();
  let intercepted: typeof fetch;
  beforeAll(() => {
    server.listen({ onUnhandledFrame: 'error' });
    intercepted = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const request = new Request(input, init);
      request.headers.set('Connection', 'close');
      return intercepted(request);
    };
  });
  afterEach(() => server.resetHandlers());
  afterAll(() => {
    globalThis.fetch = intercepted;
    server.close();
  });
  return server;
}
