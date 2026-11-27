import { _electron as electron, test } from '@playwright/test';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:https';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

type ReportDelivery = { url: string; body: string; cookie?: string; authorization?: string };
type ReportingFixture = {
  root: string;
  address: { port: number };
  launch: () => ReturnType<typeof electron.launch>;
  received: ReportDelivery[];
};
export const reportingTest = test.extend<{ receiver: ReportingFixture }>({
  receiver: async ({ browserName: _browserName }, use) => {
    const root = await mkdtemp(join(tmpdir(), 'openkraken-reporting-tls-'));
    const main = resolve(`apps/desktop/dist/reporting-test-${randomUUID()}.cjs`);
    const cert = join(root, 'cert.pem');
    const key = join(root, 'key.pem');
    execFileSync(process.execPath, [resolve('scripts/create-loopback-certificate.mjs'), root]);
    const received: ReportDelivery[] = [];
    const server = createServer(
      { key: await readFile(key), cert: await readFile(cert) },
      (request, response) => {
        let body = '';
        request.on('data', (chunk) => {
          body += chunk;
          if (body.length > 4096) request.destroy();
        });
        request.on('end', () => {
          received.push({
            url: request.url!,
            body,
            cookie: request.headers.cookie,
            authorization: request.headers.authorization,
          });
          response.end('{}');
        });
      },
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing TLS receiver');
    const dsn = `https://0123456789abcdef0123456789abcdef@127.0.0.1:${address.port}/123`;
    try {
      // Build a fixture entry point with a fixed test destination. Production has
      // no environment/runtime override and its default compiled destination is null.
      await build({
        entryPoints: ['apps/desktop/src/bootstrap.ts'],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        external: ['electron', '@parcel/watcher', 'node-pty'],
        target: 'node24',
        outfile: main,
        define: {
          __OPENKRAKEN_SENTRY_DSN__: JSON.stringify(dsn),
          __OPENKRAKEN_UPDATE_CONFIG__: 'null',
        },
      });
      await mkdir(join(root, 'app'));
      await writeFile(
        join(root, 'app/package.json'),
        JSON.stringify({ name: 'openkraken', version: '0.1.0', main }),
      );
      const { NODE_TLS_REJECT_UNAUTHORIZED: _tlsOverride, ...env } = process.env;
      const launch = () =>
        electron.launch({
          args: [join(root, 'app'), `--user-data-dir=${join(root, 'profile')}`],
          env: { ...env, NODE_EXTRA_CA_CERTS: cert },
        });
      await use({ root, address, launch, received });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(main, { force: true });
      await rm(root, { recursive: true, force: true });
    }
  },
});
