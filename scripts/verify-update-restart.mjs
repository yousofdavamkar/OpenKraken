import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { packager } from '@electron/packager';
import { flipFuses, FuseVersion } from '@electron/fuses';
import { chromium, expect } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { buildAppImage } from './appimage.mjs';
import { packageFuses, sha256, verifyFuses } from './package-security.mjs';

if (process.platform !== 'linux') throw new Error('Linux AppImage acceptance requires Linux');
await mkdir('release', { recursive: true });
const root = await mkdtemp(resolve('release/update-restart-check-'));
let server, child, browser, mainPid;
let completed = false;
let launchOutput = '';
const marker = join(root, 'started.json');
async function waitForFile(path, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await delay(50);
  }
  throw new Error('Replacement startup was not acknowledged');
}
try {
  const cert = join(root, 'cert.pem'),
    key = join(root, 'key.pem');
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
  let envelope, artifact;
  server = createServer(
    { key: await readFile(key), cert: await readFile(cert) },
    (request, response) => {
      if (request.url === '/release.json' && envelope) response.end(envelope);
      else if (request.url === '/OpenKraken.AppImage' && artifact)
        createReadStream(artifact).pipe(response);
      else {
        response.writeHead(404);
        response.end();
      }
    },
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const config = {
    feed: `https://127.0.0.1:${server.address().port}/release.json`,
    publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  };
  const images = [];
  for (const version of ['0.1.0', '0.2.0']) {
    const staging = join(root, version, 'staging');
    await mkdir(staging, { recursive: true });
    await cp('apps/desktop/dist', join(staging, 'dist'), { recursive: true });
    // Test trust and dialog responses are compiled into disposable fixture apps.
    // Production has no TLS bypass, test key or runtime test switch.
    const banner = `
      const fixtureElectron = require('electron');
      require('node:fs').appendFileSync(${JSON.stringify(join(root, 'boot.log'))}, JSON.stringify({ version: ${JSON.stringify(version)}, pid: process.pid, executable: process.execPath, image: process.env.APPIMAGE, appdir: process.env.APPDIR }) + '\\n');
      const fixtureRelaunch = fixtureElectron.app.relaunch.bind(fixtureElectron.app);
      fixtureElectron.app.relaunch = (options) => { require('node:fs').writeFileSync(${JSON.stringify(join(root, 'relaunch.json'))}, JSON.stringify(options)); return fixtureRelaunch(options); };
      const fixtureTls = require('node:tls');
      fixtureTls.setDefaultCACertificates([...fixtureTls.getCACertificates('default'), ${JSON.stringify(await readFile(cert, 'utf8'))}]);
      fixtureElectron.dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
      fixtureElectron.dialog.showMessageBoxSync = () => 0;
      fixtureElectron.dialog.showErrorBox = (title) => require('node:fs').writeFileSync(${JSON.stringify(join(root, 'install-error'))}, title);
      const fixtureHandle = fixtureElectron.ipcMain.handle.bind(fixtureElectron.ipcMain);
      fixtureElectron.ipcMain.handle = (channel, listener) => fixtureHandle(channel, async (...args) => {
        const result = await listener(...args);
        if (${JSON.stringify(version)} === '0.2.0' && args[1]?.method === 'updatesStarted') {
          require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ version: fixtureElectron.app.getVersion(), pid: process.pid, state: result }));
          setTimeout(() => fixtureElectron.app.quit(), 100);
        }
        return result;
      });
    `;
    await build({
      entryPoints: ['apps/desktop/src/main.ts'],
      outfile: join(staging, 'dist/main.cjs'),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node24',
      external: ['electron', '@parcel/watcher', 'node-pty'],
      define: {
        __OPENKRAKEN_SENTRY_DSN__: 'null',
        __OPENKRAKEN_UPDATE_CONFIG__: JSON.stringify(config),
      },
      banner: { js: banner },
    });
    await writeFile(
      join(staging, 'package.json'),
      JSON.stringify({
        name: 'openkraken',
        productName: 'OpenKraken',
        version,
        main: 'dist/main.cjs',
      }),
    );
    const [bundle] = await packager({
      dir: staging,
      out: join(root, version, 'bundle'),
      name: 'OpenKraken',
      executableName: 'openkraken',
      electronVersion: '45.2.1',
      asar: {
        unpack: '**/*.node',
        unpackDir: 'dist/{helpers,node_modules/node-pty,shell-integration}',
      },
      overwrite: true,
    });
    await flipFuses(join(bundle, 'openkraken'), { version: FuseVersion.V1, ...packageFuses });
    await verifyFuses(join(bundle, 'openkraken'));
    const work = join(root, version, 'image');
    await mkdir(work);
    images.push(
      (await buildAppImage(bundle, work, 'OpenKraken.AppImage', { version, testOnly: true }))
        .artifact,
    );
  }
  artifact = images[1];
  const now = Date.now();
  const payload = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      product: 'org.openkraken.desktop',
      channel: 'stable',
      sequence: 1,
      version: '0.2.0',
      issuedAt: now - 1000,
      expiresAt: now + 86400000,
      artifacts: [
        {
          platform: 'linux',
          arch: process.arch,
          format: 'AppImage',
          name: 'OpenKraken.AppImage',
          size: (await stat(artifact)).size,
          sha256: await sha256(artifact),
        },
      ],
    }),
  );
  envelope = JSON.stringify({
    payload: payload.toString('base64'),
    signature: sign(
      null,
      Buffer.concat([Buffer.from('OPENKRAKEN-UPDATE-V1\n'), payload]),
      keys.privateKey,
    ).toString('base64'),
  });
  const target = join(root, 'Installed OpenKraken.AppImage');
  await cp(images[0], target);
  const originalDigest = await sha256(target);
  const profile = join(root, 'profile');
  await mkdir(profile);
  child = spawn(target, ['--remote-debugging-port=0', `--user-data-dir=${profile}`], {
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, TMPDIR: root },
  });
  const endpoint = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`AppImage did not start: ${output}`)), 15000);
    createInterface({ input: child.stderr }).on('line', (line) => {
      output = (output + '\n' + line).slice(-4096);
      launchOutput = (launchOutput + '\n' + line).slice(-8192);
      const match = /DevTools listening on (ws:\/\/.*)/.exec(line);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`AppImage exited ${code}: ${output}`));
    });
  });
  browser = await chromium.connectOverCDP(endpoint);
  const session = await browser.newBrowserCDPSession();
  mainPid = (await session.send('SystemInfo.getProcessInfo')).processInfo.find(
    (entry) => entry.type === 'browser',
  ).id;
  await session.detach();
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? (await context.waitForEvent('page'));
  await page.getByRole('button', { name: 'Updates', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'App updates' });
  await dialog.getByRole('button', { name: 'Check for updates' }).click();
  await dialog.getByRole('button', { name: 'Download AppImage' }).click();
  await expect(
    dialog.getByRole('button', { name: 'Install and restart', exact: true }),
  ).toBeVisible({ timeout: 30000 });
  const first = await page.evaluate(() =>
    window.openkraken.request({ id: crypto.randomUUID(), method: 'updatesRead' }),
  );
  assert.ok(first.state.installId);
  await page.evaluate(() => {
    const prevent = (event) => {
      event.preventDefault();
      event.returnValue = '';
    };
    Reflect.set(window, 'fixtureUnload', prevent);
    window.addEventListener('beforeunload', prevent);
  });
  await dialog.getByRole('button', { name: 'Install and restart', exact: true }).click();
  await expect
    .poll(
      async () => {
        const state = await page.evaluate(() =>
          window.openkraken.request({ id: crypto.randomUUID(), method: 'updatesRead' }),
        );
        return (
          state.state.phase === 'verified' &&
          !!state.state.installId &&
          state.state.installId !== first.state.installId
        );
      },
      { timeout: 30000 },
    )
    .toBe(true);
  await expect(
    dialog.getByRole('button', { name: 'Install and restart', exact: true }),
  ).toBeVisible({ timeout: 30000 });
  assert.equal(await sha256(target), originalDigest);
  await assert.rejects(stat(target + '.openkraken-update'), { code: 'ENOENT' });
  console.log('Cancelled restart preserved the original AppImage and removed staging.');
  await page.evaluate(() =>
    window.removeEventListener('beforeunload', Reflect.get(window, 'fixtureUnload')),
  );
  await dialog.getByRole('button', { name: 'Install and restart', exact: true }).click();
  const started = JSON.parse(await waitForFile(marker));
  assert.equal(started.version, '0.2.0');
  assert.equal(started.state.kind, 'updates');
  assert.equal(started.state.state.error, null);
  assert.equal(await sha256(target), await sha256(artifact));
  await assert.rejects(stat(target + '.openkraken-update'), { code: 'ENOENT' });
  await delay(500);
  console.log(
    'Packaged AppImage: signed HTTPS download, cancelled unsaved-work restart, accepted install, new-version launch and recovery acknowledgement passed.',
  );
  completed = true;
} catch (error) {
  console.error('Fixture launch diagnostics:', launchOutput);
  for (const name of ['install-error', 'relaunch.json', 'boot.log']) {
    console.error(name, await readFile(join(root, name), 'utf8').catch(() => 'absent'));
  }
  throw error;
} finally {
  await browser?.close().catch(() => {});
  if (mainPid) {
    try {
      process.kill(mainPid, 'SIGTERM');
    } catch {}
  }
  try {
    const started = JSON.parse(await readFile(marker, 'utf8'));
    process.kill(started.pid, 'SIGTERM');
  } catch {}
  if (child?.pid) {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
  }
  server?.closeAllConnections();
  if (server) await new Promise((resolve) => server.close(resolve));
  await delay(300);
  if (completed) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  else console.error('Retained disposable failure fixture:', root);
}
