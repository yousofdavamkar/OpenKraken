import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/** Local LFS batch/basic upload fixture. It never forwards requests to another host. */
export async function lfsRemote(options: { authenticated?: boolean; tls?: boolean } = {}) {
  const credentials = { username: 'fixture-lfs', password: 'fixture-lfs-token' };
  const authorization = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`;
  const uploads = new Map<string, Buffer>();
  const events: string[] = [];
  let mode: 'accept' | 'reject' | 'stall' = 'accept';
  let url = '';
  let started!: () => void;
  const uploadStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const json = (response: ServerResponse, body: unknown, status = 200) => {
    response.writeHead(status, { 'Content-Type': 'application/vnd.git-lfs+json' });
    response.end(JSON.stringify(body));
  };
  const body = async (request: IncomingMessage) => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > 4 * 1024 * 1024) throw new Error('Fixture request too large');
      chunks.push(bytes);
    }
    return Buffer.concat(chunks);
  };
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    if (options.authenticated && request.headers.authorization !== authorization) {
      response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="LFS upload fixture"' });
      response.end();
      return;
    }
    const path = new URL(request.url!, 'http://fixture.test').pathname;
    if (path === '/lfs/locks/verify' && request.method === 'POST') {
      events.push('verify-locks');
      json(response, { ours: [], theirs: [] });
    } else if (path === '/lfs/objects/batch' && request.method === 'POST') {
      const input: { operation: string; objects: { oid: string; size: number }[] } = JSON.parse(
        (await body(request)).toString(),
      );
      if (input.operation !== 'upload') {
        json(response, { message: 'Only uploads are supported' }, 400);
        return;
      }
      events.push('batch');
      json(response, {
        transfer: 'basic',
        objects: input.objects.map(({ oid, size }) => ({
          oid,
          size,
          authenticated: true,
          ...(uploads.has(oid)
            ? {}
            : {
                actions: {
                  upload: {
                    href: `${url}/objects/${oid}`,
                    header: { Authorization: authorization },
                  },
                },
              }),
        })),
      });
    } else if (/^\/lfs\/objects\/[a-f0-9]{64}$/.test(path) && request.method === 'PUT') {
      const oid = path.slice(path.lastIndexOf('/') + 1);
      const bytes = await body(request);
      events.push('upload');
      started();
      if (mode === 'stall') return;
      if (mode === 'reject') {
        json(response, { message: 'Fixture upload denied' }, 403);
        return;
      }
      if (createHash('sha256').update(bytes).digest('hex') !== oid) {
        json(response, { message: 'Object hash mismatch' }, 422);
        return;
      }
      uploads.set(oid, bytes);
      response.writeHead(200);
      response.end();
    } else json(response, { message: 'Unexpected fixture route' }, 404);
  };
  const handler = (request: IncomingMessage, response: ServerResponse) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) json(response, { message: 'Invalid fixture request' }, 400);
      else response.destroy();
    });
  };
  const certificate = resolve('packages/test-fixtures/tls/localhost-test.crt');
  const server = options.tls
    ? createSecureServer(
        {
          key: await readFile(resolve('packages/test-fixtures/tls/localhost-test.key')),
          cert: await readFile(certificate),
        },
        handler,
      )
    : createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
  url = `${options.tls ? 'https' : 'http'}://127.0.0.1:${address.port}/lfs`;
  return {
    url,
    certificate,
    credentials,
    uploads,
    events,
    uploadStarted,
    setUploadMode(value: typeof mode) {
      mode = value;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
