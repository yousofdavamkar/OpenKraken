import { createServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fixtureGit } from './index.js';
/** A local authenticated dumb-HTTPS Git server; TLS remains verified by clients. */
export async function authenticatedRemote(
  path: string,
  options: { basePath?: string; password?: string; redirect?: string } = {},
) {
  fixtureGit(path, ['update-server-info']);
  const certificate = resolve('packages/test-fixtures/tls/localhost-test.crt');
  const credentials = {
    username: 'fixture-user',
    password: options.password ?? 'fixture-password-✓',
  };
  const authorization =
    'Basic ' + Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64');
  let authenticated = 0;
  let requests = 0;
  const server = createServer(
    {
      key: await readFile(resolve('packages/test-fixtures/tls/localhost-test.key')),
      cert: await readFile(certificate),
    },
    (request, response) => {
      requests++;
      if (request.headers.authorization !== authorization) {
        response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="OpenKraken test"' });
        response.end();
        return;
      }
      authenticated++;
      if (options.redirect) {
        response.writeHead(302, { location: options.redirect }).end();
        return;
      }
      const pathname = new URL(request.url!, 'https://localhost').pathname;
      const base = options.basePath ?? '';
      if (!pathname.startsWith(base + '/')) {
        response.writeHead(404).end();
        return;
      }
      const file = resolve(path, '.' + pathname.slice(base.length));
      if (!file.startsWith(resolve(path) + sep)) {
        response.writeHead(403).end();
        return;
      }
      void readFile(file).then(
        (bytes) => response.end(bytes),
        () => response.writeHead(404).end(),
      );
    },
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
  return {
    url: `https://127.0.0.1:${address.port}${options.basePath ?? ''}`,
    certificate,
    credentials,
    authenticated: () => authenticated,
    requests: () => requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
