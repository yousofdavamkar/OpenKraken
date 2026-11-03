import { _electron as electron, expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:https';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('the default build has no reporting destination and cannot be opted in', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'openkraken-no-reporting-'));
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${profile}`],
  });
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Crash reporting', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Crash reporting' });
    await expect(dialog.getByRole('checkbox', { name: 'Send crash summaries' })).not.toBeChecked();
    await expect(dialog.getByRole('checkbox')).toBeDisabled();
    await expect(dialog).toContainText(
      'This build has no crash-report destination. No reports are sent.',
    );
    await expect(dialog.getByRole('button', { name: 'Apply' })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Close' }).click();
    const result = await page.evaluate(() =>
      window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'crashReportingSave',
        enabled: true,
        revision: null,
      }),
    );
    expect(result).toMatchObject({ kind: 'error', code: 'CRASH_REPORTING_SETTINGS' });
    await expect(readFile(join(profile, 'crash-reporting.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    await app.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test('real renderer crashes reach a trusted TLS receiver only after persisted consent', async () => {
  test.skip(
    process.platform !== 'linux',
    'Local OpenSSL trust fixture currently validated on Linux',
  );
  const root = await mkdtemp(join(tmpdir(), 'openkraken-reporting-tls-'));
  const main = resolve(`apps/desktop/dist/reporting-test-${randomUUID()}.cjs`);
  const cert = join(root, 'cert.pem');
  const key = join(root, 'key.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ],
    { stdio: 'ignore' },
  );
  const received: { url: string; body: string; cookie?: string; authorization?: string }[] = [];
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
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    // Build a fixture entry point with a fixed test destination. Production has
    // no environment/runtime override and its default compiled destination is null.
    await build({
      entryPoints: ['apps/desktop/src/main.ts'],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['electron', '@parcel/watcher', 'node-pty'],
      target: 'node24',
      outfile: main,
      define: { __OPENKRAKEN_SENTRY_DSN__: JSON.stringify(dsn) },
    });
    await mkdir(join(root, 'app'));
    await writeFile(
      join(root, 'app/package.json'),
      JSON.stringify({ name: 'openkraken', version: '0.1.0', main }),
    );
    const launch = () =>
      electron.launch({
        args: [join(root, 'app'), `--user-data-dir=${join(root, 'profile')}`],
        env: { ...process.env, NODE_EXTRA_CA_CERTS: cert },
      });
    const crash = async () =>
      app!.evaluate(async ({ BrowserWindow }) => {
        const contents = BrowserWindow.getAllWindows()[0]!.webContents;
        const gone = new Promise<void>((resolve) =>
          contents.once('render-process-gone', () => resolve()),
        );
        contents.forcefullyCrashRenderer();
        await gone;
      });
    app = await launch();
    let page = await app.firstWindow();
    await expect(page.getByRole('button', { name: 'Crash reporting', exact: true })).toBeEnabled();
    await crash();
    await app.close();
    expect(received).toHaveLength(0);

    app = await launch();
    page = await app.firstWindow();
    await page.getByRole('button', { name: 'Crash reporting', exact: true }).click();
    let dialog = page.getByRole('dialog', { name: 'Crash reporting' });
    await expect(dialog).toContainText(`https://127.0.0.1:${address.port}`);
    await dialog.getByRole('checkbox', { name: 'Send crash summaries' }).check();
    await dialog.getByRole('button', { name: 'Apply' }).click();
    await expect(dialog.getByRole('status')).toHaveText('Crash reporting is on.');
    await dialog.getByRole('button', { name: 'Close' }).click();
    await app.close();

    app = await launch();
    page = await app.firstWindow();
    await page.getByRole('button', { name: 'Crash reporting', exact: true }).click();
    await expect(page.getByRole('checkbox', { name: 'Send crash summaries' })).toBeChecked();
    await page.screenshot({ path: 'test-results/crash-reporting-consent.png' });
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    const utilityFailure = await app.evaluate(async ({ app }) => {
      const service = app.getAppMetrics().find((metric) => metric.name === 'OpenKraken Git');
      if (!service) throw new Error('Missing Git utility');
      const gone = new Promise<{ reason: string; name?: string; serviceName?: string }>((resolve) =>
        app.once('child-process-gone', (_event, details) =>
          resolve({ reason: details.reason, name: details.name, serviceName: details.serviceName }),
        ),
      );
      process.kill(service.pid, 'SIGSEGV');
      return gone;
    });
    expect(utilityFailure.reason).toBe('crashed');
    await expect.poll(() => received.length).toBe(1);
    expect(JSON.parse(received[0]!.body.trim().split('\n')[2]!).tags).toEqual({
      process: 'git',
      reason: 'crashed',
      os: 'linux',
      arch: process.arch,
    });
    received.splice(0);
    await crash();
    await expect.poll(() => received.length).toBe(1);
    expect(received[0]).toMatchObject({
      url: '/api/123/envelope/',
      cookie: undefined,
      authorization: undefined,
    });
    const payload = JSON.parse(received[0]!.body.trim().split('\n')[2]!);
    expect(payload).toEqual({
      event_id: expect.stringMatching(/^[a-f0-9]{32}$/),
      platform: 'native',
      level: 'fatal',
      release: 'openkraken@0.1.0',
      message: 'OpenKraken process failure',
      tags: { process: 'renderer', reason: 'crashed', os: 'linux', arch: process.arch },
    });
    expect(received[0]!.body).not.toContain(root);
    await app.close();

    app = await launch();
    page = await app.firstWindow();
    await page.getByRole('button', { name: 'Crash reporting', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'Crash reporting' });
    await dialog.getByRole('checkbox', { name: 'Send crash summaries' }).uncheck();
    await dialog.getByRole('button', { name: 'Apply' }).click();
    await expect(dialog.getByRole('status')).toHaveText('Crash reporting is off.');
    await dialog.getByRole('button', { name: 'Close' }).click();
    await crash();
    await app.close();
    app = undefined;
    expect(received).toHaveLength(1);
  } finally {
    await app?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(main, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});
