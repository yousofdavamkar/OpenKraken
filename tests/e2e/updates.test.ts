import { _electron as electron, expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { createServer } from 'node:https';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('the default build stays disconnected and offers no update download', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'openkraken-updates-disabled-'));
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${profile}`],
    env: {
      ...process.env,
      OPENKRAKEN_UPDATE_CONFIG:
        '{"feed":"https://untrusted.example.test/release.json","publicKey":"invalid"}',
    },
  });
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Updates', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'App updates' });
    await expect(dialog.getByRole('status')).toHaveText(
      'This build has no update feed configured.',
    );
    await expect(dialog.getByRole('button', { name: 'Check for updates' })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: /Download/ })).toHaveCount(0);
    await expect(
      dialog.getByRole('checkbox', { name: 'Automatically check every 10 hours' }),
    ).toHaveCount(0);
    expect(
      await page.evaluate(() =>
        window.openkraken.request({ id: crypto.randomUUID(), method: 'updatesCheck' }),
      ),
    ).toMatchObject({ kind: 'updates', state: { phase: 'disabled' } });
    await expect(stat(join(profile, 'updates'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await app.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test('signed update UI checks, downloads, cancels and rejects tampering through real HTTPS', async () => {
  // Includes the real startup delay, background notice polling and two consent restarts.
  test.setTimeout(90000);
  test.skip(process.platform !== 'linux', 'Local OpenSSL fixture currently validated on Linux');
  const root = await mkdtemp(join(tmpdir(), 'openkraken-update-e2e-'));
  const main = resolve(`apps/desktop/dist/update-test-${randomUUID()}.cjs`);
  let server: ReturnType<typeof createServer> | undefined;
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
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
    const keys = generateKeyPairSync('ed25519');
    let sequence = 7;
    let tamper = false;
    let slow = false;
    const issuedAt = Date.now() - 1000;
    const expiresAt = Date.now() + 86400000;
    const requests: string[] = [];
    server = createServer(
      { key: await readFile(key), cert: await readFile(cert) },
      (request, response) => {
        requests.push(request.url!);
        if (request.url === '/stable/release.json') {
          const payload = Buffer.from(
            JSON.stringify({
              schemaVersion: 1,
              product: 'org.openkraken.desktop',
              channel: 'stable',
              sequence,
              version: '0.2.0',
              issuedAt,
              expiresAt,
              artifacts: [
                {
                  platform: 'linux',
                  arch: 'x64',
                  format: 'AppImage',
                  name: 'OpenKraken.AppImage',
                  size: 7,
                  sha256: 'f16d05ec6b29248d2c61adb1e9263f78e4f7bace1b955014a2d17872cfe4064d',
                },
              ],
            }),
          );
          const signature = sign(
            null,
            Buffer.concat([Buffer.from('OPENKRAKEN-UPDATE-V1\n'), payload]),
            keys.privateKey,
          );
          if (tamper) signature[0] = signature[0]! ^ 1;
          response.end(
            JSON.stringify({
              payload: payload.toString('base64'),
              signature: signature.toString('base64'),
            }),
          );
        } else if (request.url === '/stable/OpenKraken.AppImage') {
          if (slow) response.write('fix');
          else response.end('fixture');
        } else {
          response.writeHead(404);
          response.end();
        }
      },
    );
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing TLS fixture');
    const config = {
      feed: `https://127.0.0.1:${address.port}/stable/release.json`,
      publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    };
    await build({
      entryPoints: ['apps/desktop/src/main.ts'],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['electron', '@parcel/watcher', 'node-pty'],
      target: 'node24',
      outfile: main,
      define: {
        __OPENKRAKEN_SENTRY_DSN__: 'null',
        __OPENKRAKEN_UPDATE_CONFIG__: JSON.stringify(config),
      },
    });
    await mkdir(join(root, 'app'));
    await writeFile(
      join(root, 'app/package.json'),
      JSON.stringify({ name: 'openkraken-update-fixture', version: '0.1.0', main }),
    );
    const profile = join(root, 'profile');
    const args = [join(root, 'app'), `--user-data-dir=${profile}`];
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env))
      if (value !== undefined) env[name] = value;
    env.NODE_EXTRA_CA_CERTS = cert;
    delete env.NODE_TLS_REJECT_UNAUTHORIZED;
    app = await electron.launch({ args, env });
    let page = await app.firstWindow();
    await page.getByRole('button', { name: 'Updates', exact: true }).click();
    let dialog = page.getByRole('dialog', { name: 'App updates' });
    await expect(dialog.getByRole('status')).toHaveText('Check for a newer signed release.');
    expect(requests).toHaveLength(0);
    await dialog.getByRole('button', { name: 'Check for updates' }).click();
    await expect(dialog.getByRole('status')).toHaveText('Version 0.2.0 is available.');
    await dialog.getByRole('button', { name: 'Download AppImage' }).click();
    await expect(dialog.getByRole('status')).toContainText('download verified');
    expect(await readFile(join(profile, 'updates/artifact.ready'), 'utf8')).toBe('fixture');
    await page.screenshot({ path: 'test-results/signed-update-verified.png' });
    slow = true;
    await dialog.getByRole('button', { name: 'Check for updates' }).click();
    await dialog.getByRole('button', { name: 'Download AppImage' }).click();
    await expect(dialog.getByRole('progressbar', { name: 'Download progress' })).toHaveAttribute(
      'value',
      '3',
    );
    await dialog.getByRole('button', { name: 'Cancel transfer' }).click();
    await expect(dialog.getByRole('status')).toHaveText('Update transfer cancelled.');
    await expect(stat(join(profile, 'updates/artifact.part'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    tamper = true;
    await dialog.getByRole('button', { name: 'Check for updates' }).click();
    await expect(dialog.getByRole('status')).toContainText(
      'signature or validity period could not be verified',
    );
    await expect(dialog.getByRole('button', { name: 'Download AppImage' })).toHaveCount(0);
    tamper = false;
    slow = false;
    const automatic = dialog.getByRole('checkbox', { name: 'Automatically check every 10 hours' });
    await expect(automatic).not.toBeChecked();
    await automatic.check();
    await expect(automatic).toBeEnabled();
    await expect(automatic).toBeChecked();
    const beforeAutomatic = requests.length;
    await app.close();
    app = await electron.launch({ args, env });
    page = await app.firstWindow();
    await expect.poll(() => requests.length, { timeout: 35000 }).toBe(beforeAutomatic + 1);
    await expect(page.getByRole('button', { name: 'Updates', exact: true })).toHaveAttribute(
      'title',
      'OpenKraken 0.2.0 is available',
      { timeout: 35000 },
    );
    await page.getByRole('button', { name: 'Updates', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'App updates' });
    await expect(dialog.getByRole('status')).toHaveText('Version 0.2.0 is available.');
    await expect(
      dialog.getByRole('checkbox', { name: 'Automatically check every 10 hours' }),
    ).toBeChecked();
    await expect(page.getByRole('button', { name: 'Updates', exact: true })).toHaveAttribute(
      'title',
      'OpenKraken 0.2.0 is available',
    );
    await page.screenshot({ path: 'test-results/automatic-updates.png' });
    await dialog.getByRole('checkbox', { name: 'Automatically check every 10 hours' }).uncheck();
    await expect(
      dialog.getByRole('checkbox', { name: 'Automatically check every 10 hours' }),
    ).toBeEnabled();
    await expect(
      dialog.getByRole('checkbox', { name: 'Automatically check every 10 hours' }),
    ).not.toBeChecked();
    sequence = 6;
    await app.close();
    app = await electron.launch({ args, env });
    page = await app.firstWindow();
    await page.getByRole('button', { name: 'Updates', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'App updates' });
    await expect(
      dialog.getByRole('checkbox', { name: 'Automatically check every 10 hours' }),
    ).not.toBeChecked();
    await dialog.getByRole('button', { name: 'Check for updates' }).click();
    await expect(dialog.getByRole('status')).toContainText('older or conflicting release metadata');
    sequence = 8;
    slow = true;
    await dialog.getByRole('button', { name: 'Check for updates' }).click();
    await dialog.getByRole('button', { name: 'Download AppImage' }).click();
    await expect(dialog.getByRole('progressbar', { name: 'Download progress' })).toHaveAttribute(
      'value',
      '3',
    );
    const closing = performance.now();
    await app.close();
    app = undefined;
    expect(performance.now() - closing).toBeLessThan(2000);
    await expect(stat(join(profile, 'updates/artifact.part'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    await app?.close();
    server?.closeAllConnections();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await rm(main, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});
