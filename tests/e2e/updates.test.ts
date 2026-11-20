import { _electron as electron, expect, test } from '@playwright/test';
import { build } from 'esbuild';
import type { UpdateConfiguration } from '../../apps/desktop/src/update-protocol.js';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createServer } from 'node:https';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

async function buildFixture(main: string, config: UpdateConfiguration) {
  await build({
    entryPoints: ['apps/desktop/src/bootstrap.ts'],
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
}

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

async function updatePackage(manifestPath?: string) {
  if (!manifestPath) {
    const format =
      process.platform === 'win32' ? 'msi' : process.platform === 'darwin' ? 'dmg' : 'deb';
    return {
      format,
      filename: 'OpenKraken.' + format,
      version: '0.2.0',
      size: 7,
      sha256: createHash('sha256').update('fixture').digest('hex'),
      path: undefined,
    };
  }
  const manifest: {
    platform: string;
    arch: string;
    target: string;
    version: string;
    artifact: { file: string; size: number; sha256: string };
  } = JSON.parse(await readFile(manifestPath, 'utf8'));
  expect(manifest.platform).toBe(process.platform);
  expect(manifest.arch).toBe(process.arch);
  const { file: filename, size, sha256 } = manifest.artifact;
  expect(basename(filename)).toBe(filename);
  const path = join(dirname(manifestPath), filename);
  expect((await stat(path)).size).toBe(size);
  return {
    format: manifest.target,
    filename,
    version: manifest.version,
    size,
    sha256,
    path,
  };
}

async function fileDigest(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

test('signed update UI checks, downloads, cancels and rejects tampering through real HTTPS', async () => {
  // Both artifact sizes exercise seven Electron launches, automatic checks and feed migration.
  test.setTimeout(180000);
  const manifestPath = process.env.OPENKRAKEN_UPDATE_TEST_MANIFEST;
  const { format, filename, version, size, sha256, path } = await updatePackage(manifestPath);
  const channel = version.includes('-beta.') ? 'beta' : 'stable';
  let feedPath = `/${channel}/release.json`;
  const root = await mkdtemp(join(tmpdir(), 'openkraken-update-e2e-'));
  const main = resolve(`apps/desktop/dist/update-test-${randomUUID()}.cjs`);
  let server: ReturnType<typeof createServer> | undefined;
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    const cert = join(root, 'cert.pem');
    const key = join(root, 'key.pem');
    execFileSync(process.execPath, [resolve('scripts/create-loopback-certificate.mjs'), root]);
    const keys = generateKeyPairSync('ed25519');
    let signingKey = keys.privateKey;
    let publishedEnvelope: string | undefined;
    let sequence = 6;
    // A trusted signer can publish the wrong digest. Check it against the downloaded bytes.
    const wrongDigest = (sha256.startsWith('0') ? '1' : '0') + sha256.slice(1);
    let tamper = false;
    let slow = false;
    const issuedAt = Date.now() - 1000;
    const expiresAt = Date.now() + 86400000;
    const requests: string[] = [];
    server = createServer(
      { key: await readFile(key), cert: await readFile(cert) },
      (request, response) => {
        requests.push(request.url!);
        if (request.url === feedPath) {
          if (publishedEnvelope) {
            response.end(publishedEnvelope);
            return;
          }
          const payload = Buffer.from(
            JSON.stringify({
              schemaVersion: 1,
              product: 'org.openkraken.desktop',
              channel,
              sequence,
              version,
              issuedAt,
              expiresAt,
              artifacts: [
                {
                  platform: process.platform,
                  arch: process.arch,
                  format,
                  name: filename,
                  size,
                  sha256: sequence === 6 ? wrongDigest : sha256,
                },
              ],
            }),
          );
          const signature = sign(
            null,
            Buffer.concat([Buffer.from('OPENKRAKEN-UPDATE-V1\n'), payload]),
            signingKey,
          );
          if (tamper) signature[0] = signature[0]! ^ 1;
          response.end(
            JSON.stringify({
              payload: payload.toString('base64'),
              signature: signature.toString('base64'),
            }),
          );
        } else if (request.url === feedPath.slice(0, feedPath.lastIndexOf('/') + 1) + filename) {
          if (slow) response.write('fix');
          else if (path)
            void pipeline(createReadStream(path), response).catch(() => response.destroy());
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
    const config: UpdateConfiguration = {
      channel,
      feed: `https://127.0.0.1:${address.port}${feedPath}`,
      publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    };
    await buildFixture(main, config);
    await mkdir(join(root, 'app'));
    await writeFile(
      join(root, 'app/package.json'),
      JSON.stringify({ name: 'openkraken-update-fixture', version: '0.0.0', main }),
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
    await expect(dialog.getByText(/Beta channel/)).toHaveCount(channel === 'beta' ? 1 : 0);
    await dialog.getByRole('button', { name: 'Check for updates' }).click();
    await expect(dialog.getByRole('status')).toHaveText(`Version ${version} is available.`);
    await dialog.getByRole('button', { name: `Download ${format}` }).click();
    await expect(dialog.getByRole('status')).toContainText('did not match the signed release', {
      timeout: 60000,
    });
    await expect(dialog.getByRole('button', { name: 'Save installer…' })).toHaveCount(0);
    await expect(stat(join(profile, 'updates/artifact.ready'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(stat(join(profile, 'updates/artifact.part'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    sequence = 7;
    await dialog.getByRole('button', { name: 'Check for updates' }).click();
    await dialog.getByRole('button', { name: `Download ${format}` }).click();
    await expect(dialog.getByRole('status')).toContainText('download verified', { timeout: 60000 });
    expect(await fileDigest(join(profile, 'updates/artifact.ready'))).toBe(sha256);
    await page.screenshot({ path: test.info().outputPath('signed-update-verified.png') });
    const beforeRecovery = requests.length;
    const exited = once(app.process(), 'exit');
    expect(app.process().kill('SIGKILL')).toBe(true);
    await exited;
    app = await electron.launch({ args, env });
    page = await app.firstWindow();
    await page.getByRole('button', { name: 'Updates', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'App updates' });
    await expect(dialog.getByRole('status')).toHaveText('Check for a newer signed release.');
    expect(requests).toHaveLength(beforeRecovery);
    await dialog.getByRole('button', { name: 'Check for updates' }).click();
    await dialog.getByRole('button', { name: `Download ${format}` }).click();
    await expect(dialog.getByRole('status')).toContainText('download verified', { timeout: 60000 });
    expect(requests.slice(beforeRecovery)).toEqual([feedPath]);
    const exported = join(root, filename);
    const downloads = await app.evaluate(({ app }) => app.getPath('downloads'));
    await app.evaluate(
      ({ dialog }, { path, expectedPath }) => {
        let first = true;
        dialog.showSaveDialog = async (...args: unknown[]) => {
          const options = args.at(-1) as Electron.SaveDialogOptions;
          if (options.defaultPath !== expectedPath)
            throw new Error('Missing signed default filename');
          if (first) {
            first = false;
            return { canceled: true, filePath: '' };
          }
          return { canceled: false, filePath: path };
        };
      },
      { path: exported, expectedPath: join(downloads, filename) },
    );
    const save = dialog.getByRole('button', { name: 'Save installer…' });
    await save.click();
    await expect(save).toBeEnabled();
    await expect(stat(exported)).rejects.toMatchObject({ code: 'ENOENT' });
    await save.click();
    await expect(dialog.getByRole('status')).toHaveText(`Version ${version} installer saved.`, {
      timeout: 60000,
    });
    const exportedDigest = await fileDigest(exported);
    expect(exportedDigest).toBe(sha256);
    expect((await stat(exported)).size).toBe(size);
    if (manifestPath && format === 'AppImage') {
      expect((await stat(exported)).mode & 0o777).toBe(0o700);
      const runtime = await promisify(execFile)(exported, ['--appimage-version'], {
        timeout: 15000,
      });
      expect(runtime.stdout + runtime.stderr).toContain('AppImage runtime version');
    }
    if (manifestPath) {
      const receipt = {
        channel,
        platform: process.platform,
        arch: process.arch,
        format,
        version,
        filename,
        size,
        sha256: exportedDigest,
      };
      await writeFile(
        test.info().outputPath('saved-installer.json'),
        JSON.stringify(receipt, null, 2),
      );
    }
    slow = true;
    await dialog.getByRole('button', { name: 'Check for updates' }).click();
    await dialog.getByRole('button', { name: `Download ${format}` }).press('Enter');
    await expect(dialog.getByRole('progressbar', { name: 'Download progress' })).toHaveAttribute(
      'value',
      '3',
    );
    const partial = join(profile, 'updates/artifact.part');
    const stopped = once(app.process(), 'exit');
    expect(app.process().kill('SIGKILL')).toBe(true);
    await stopped;
    expect((await stat(partial)).size).toBe(3);
    const beforeRetry = requests.length;
    app = await electron.launch({ args, env });
    page = await app.firstWindow();
    await page.getByRole('button', { name: 'Updates', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'App updates' });
    await expect(dialog.getByRole('status')).toHaveText('Check for a newer signed release.');
    await expect(stat(partial)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(requests).toHaveLength(beforeRetry);
    await dialog.getByRole('button', { name: 'Check for updates' }).click();
    await dialog.getByRole('button', { name: `Download ${format}` }).press('Enter');
    await expect(dialog.getByRole('progressbar', { name: 'Download progress' })).toHaveAttribute(
      'value',
      '3',
    );
    const closeTransfer = dialog.getByRole('button', { name: 'Close' });
    await expect(closeTransfer).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(dialog.getByRole('button', { name: 'Cancel transfer' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dialog.getByRole('status')).toHaveText('Update transfer cancelled.');
    await expect(closeTransfer).toBeFocused();
    await expect(stat(join(profile, 'updates/artifact.part'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    tamper = true;
    await dialog.getByRole('button', { name: 'Check for updates' }).click();
    await expect(dialog.getByRole('status')).toContainText(
      'signature or validity period could not be verified',
    );
    await expect(dialog.getByRole('button', { name: `Download ${format}` })).toHaveCount(0);
    tamper = false;
    slow = false;
    const automatic = dialog.getByRole('checkbox', { name: 'Automatically check every 10 hours' });
    await expect(automatic).not.toBeChecked();
    await automatic.check();
    await expect(automatic).toBeEnabled();
    await expect(automatic).toBeChecked();
    await expect(automatic).toBeFocused();
    const beforeAutomatic = requests.length;
    await app.close();
    app = await electron.launch({ args, env });
    page = await app.firstWindow();
    await expect.poll(() => requests.length, { timeout: 35000 }).toBe(beforeAutomatic + 1);
    await expect(page.getByRole('button', { name: 'Updates', exact: true })).toHaveAttribute(
      'title',
      `OpenKraken ${version} is available`,
      { timeout: 35000 },
    );
    await page.getByRole('button', { name: 'Updates', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'App updates' });
    await expect(dialog.getByRole('status')).toHaveText(`Version ${version} is available.`);
    await expect(
      dialog.getByRole('checkbox', { name: 'Automatically check every 10 hours' }),
    ).toBeChecked();
    await expect(page.getByRole('button', { name: 'Updates', exact: true })).toHaveAttribute(
      'title',
      `OpenKraken ${version} is available`,
    );
    await page.screenshot({ path: test.info().outputPath('automatic-updates.png') });
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
    const previousConsent = dialog.getByRole('checkbox', {
      name: 'Automatically check every 10 hours',
    });
    await previousConsent.check();
    await expect(previousConsent).toBeEnabled();
    sequence = 8;
    slow = true;
    await dialog.getByRole('button', { name: 'Check for updates' }).click();
    await dialog.getByRole('button', { name: `Download ${format}` }).click();
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

    // A newly installed build owns the migration. The renderer cannot supply trust roots.
    const previous = { feed: config.feed, publicKey: config.publicKey };
    const nextKeys = generateKeyPairSync('ed25519');
    feedPath = `/${channel}/next/release.json`;
    const nextConfig = {
      channel: config.channel,
      feed: new URL(feedPath, config.feed).href,
      publicKey: nextKeys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    };
    await buildFixture(main, { ...nextConfig, migrateFrom: previous });
    const countBeforeMigration = requests.length;
    app = await electron.launch({ args, env });
    page = await app.firstWindow();
    await page.getByRole('button', { name: 'Updates', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'App updates' });
    const newConsent = dialog.getByRole('checkbox', { name: 'Automatically check every 10 hours' });
    await expect(newConsent).not.toBeChecked();
    expect(requests.length).toBe(countBeforeMigration);
    const check = dialog.getByRole('button', { name: 'Check for updates' });
    await check.click();
    await expect(dialog.getByRole('status')).toContainText('signature or validity period');
    signingKey = nextKeys.privateKey;
    sequence = 7;
    await check.click();
    await expect(dialog.getByRole('status')).toContainText('older or conflicting release metadata');
    sequence = 9;
    const descriptor = join(root, 'release-input.json');
    const signingPem = join(root, 'signing.pem');
    const output = join(root, 'release.json');
    await writeFile(
      descriptor,
      JSON.stringify({
        schemaVersion: 1,
        product: 'org.openkraken.desktop',
        channel,
        version,
        sequence,
        issuedAt,
        expiresAt,
        artifacts: [
          manifestPath
            ? { manifest: resolve(manifestPath) }
            : { platform: process.platform, arch: process.arch, format, path: exported },
        ],
      }),
    );
    await writeFile(signingPem, nextKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }), {
      mode: 0o600,
    });
    execFileSync(process.execPath, [
      resolve('scripts/sign-update.mjs'),
      descriptor,
      signingPem,
      output,
    ]);
    publishedEnvelope = await readFile(output, 'utf8');
    await check.click();
    await expect(dialog.getByRole('status')).toHaveText(`Version ${version} is available.`);
    expect(requests.slice(countBeforeMigration)).toEqual([feedPath, feedPath, feedPath]);
    slow = false;
    await dialog.getByRole('button', { name: `Download ${format}` }).click();
    await expect(dialog.getByRole('status')).toContainText('download verified', { timeout: 60000 });
    expect(await fileDigest(join(profile, 'updates/artifact.ready'))).toBe(sha256);
    expect(requests.at(-1)).toBe(`/${channel}/next/${filename}`);
    await newConsent.check();
    await expect(newConsent).toBeEnabled();
    await app.close();
    await buildFixture(main, nextConfig);
    app = await electron.launch({ args, env });
    page = await app.firstWindow();
    await page.getByRole('button', { name: 'Updates', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'App updates' });
    await expect(
      dialog.getByRole('checkbox', { name: 'Automatically check every 10 hours' }),
    ).toBeChecked();
    await dialog.getByRole('button', { name: 'Check for updates' }).click();
    await expect(dialog.getByRole('status')).toHaveText(`Version ${version} is available.`);

    const configFile = join(root, 'feed-config.json');
    await writeFile(configFile, JSON.stringify(nextConfig));
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [resolve('scripts/verify-update-feed.mjs'), configFile, output],
      { env },
    );
    expect(JSON.parse(stdout)).toMatchObject({
      channel,
      version,
      sequence,
      artifacts: [{ name: filename, format, size, sha256 }],
    });
    const receiptPath = test.info().outputPath('verified-feed.json');
    await writeFile(receiptPath, stdout);
    await test
      .info()
      .attach('verified-feed.json', { path: receiptPath, contentType: 'application/json' });
  } finally {
    await app?.close();
    server?.closeAllConnections();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await rm(main, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});
