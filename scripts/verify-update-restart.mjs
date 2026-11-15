import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { packager } from '@electron/packager';
import { flipFuses, FuseVersion } from '@electron/fuses';
import { chromium, expect } from '@playwright/test';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
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
const delayedDescendant = process.argv.includes('--delayed-descendant');
const failStartup = process.argv.includes('--failed-startup') || delayedDescendant;
const helperUnavailable = process.argv.includes('--helper-unavailable');
const unchangedImage = process.argv.includes('--unchanged-image');
const slowCommit = process.argv.includes('--slow-commit');
const stalledCommit = process.argv.includes('--stalled-commit');
const syncError = process.argv.includes('--sync-error-after-rename');
const beforeRename = process.argv.includes('--interrupt-before-rename');
const afterRename = process.argv.includes('--interrupt-after-rename');
const predecessorInstalled = beforeRename || stalledCommit;
const interruptedCommit = predecessorInstalled || afterRename;
assert.ok(
  [
    failStartup,
    helperUnavailable,
    unchangedImage,
    beforeRename,
    afterRename,
    slowCommit,
    stalledCommit,
    syncError,
  ].filter(Boolean).length <= 1,
  'Select one failure scenario',
);
const beta = process.argv.includes('--beta');
const initialVersion = beta ? '0.2.0-beta.2' : '0.1.0';
const replacementVersion = beta ? '0.2.0-beta.10' : '0.2.0';
const predecessorReturns = failStartup || predecessorInstalled;
const failedMarker = join(root, 'failed-startup');
const descendantMarker = join(root, 'delayed-descendant.json');
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
  await promisify(execFile)(process.execPath, [
    resolve('scripts/create-loopback-certificate.mjs'),
    root,
  ]);
  const keys = generateKeyPairSync('ed25519');
  const images = [];
  let envelope;
  server = createServer(
    { key: await readFile(key), cert: await readFile(cert) },
    (request, response) => {
      if (request.url === '/release.json' && envelope) response.end(envelope);
      else {
        const image = images.find((file) => request.url === '/' + basename(file));
        if (image) createReadStream(image).pipe(response);
        else {
          response.writeHead(404);
          response.end();
        }
      }
    },
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const config = {
    ...(beta && { channel: 'beta' }),
    feed: `https://127.0.0.1:${server.address().port}/release.json`,
    publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  };
  const signingKey = join(root, 'release-key.pem');
  await writeFile(signingKey, keys.privateKey.export({ format: 'pem', type: 'pkcs8' }), {
    mode: 0o600,
  });
  const receipts = [];
  let correctedEnvelope;
  async function publishArtifact(path, version, sequence) {
    const now = Date.now();
    const descriptor = join(root, `release-input-${sequence}.json`);
    const manifest = join(root, `release-${sequence}.json`);
    await writeFile(
      descriptor,
      JSON.stringify({
        schemaVersion: 1,
        product: 'org.openkraken.desktop',
        channel: beta ? 'beta' : 'stable',
        sequence,
        version,
        issuedAt: now - 1000,
        expiresAt: now + 86400000,
        artifacts: [{ platform: 'linux', arch: process.arch, format: 'AppImage', path }],
      }),
    );
    const { stdout } = await promisify(execFile)(process.execPath, [
      resolve('scripts/sign-update.mjs'),
      descriptor,
      signingKey,
      manifest,
    ]);
    return { receipt: JSON.parse(stdout), envelope: await readFile(manifest, 'utf8') };
  }
  for (const version of [initialVersion, replacementVersion]) {
    const staging = join(root, version, 'staging');
    await mkdir(staging, { recursive: true });
    await cp('apps/desktop/dist', join(staging, 'dist'), { recursive: true });
    // Test trust and dialog responses are compiled into disposable fixture apps.
    // Production has no TLS bypass, test key or runtime test switch.
    const banner = `
      const fixtureElectron = require('electron');
      if (${helperUnavailable}) {
        const fixtureChildProcess = require('node:child_process');
        const fixtureSpawn = fixtureChildProcess.spawn;
        fixtureChildProcess.spawn = (file, ...args) => fixtureSpawn(
          require('node:path').basename(file) === 'restart-helper' ? file + '.missing' : file, ...args);
      }
      const fixtureBootsPath = ${JSON.stringify(join(root, 'boot.json'))};
      const fixtureBoots = require('node:fs').existsSync(fixtureBootsPath) ? JSON.parse(require('node:fs').readFileSync(fixtureBootsPath, 'utf8')) : [];
      fixtureBoots.push(${JSON.stringify(version)});
      require('node:fs').writeFileSync(fixtureBootsPath, JSON.stringify(fixtureBoots));
      const fixtureReturning = ${predecessorReturns && version === initialVersion} && require('node:fs').existsSync(${JSON.stringify(failedMarker)});
      if (${syncError && version === initialVersion}) {
        const files = require('node:fs/promises');
        const rename = files.rename.bind(files);
        const open = files.open.bind(files);
        let syncParent;
        files.rename = async (from, to) => {
          await rename(from, to);
          if (from === to + '.openkraken-update/next.AppImage') syncParent = require('node:path').dirname(to);
        };
        files.open = async (path, ...args) => {
          const file = await open(path, ...args);
          if (path === syncParent) file.sync = async () => {
            require('node:fs').writeFileSync(${JSON.stringify(join(root, 'sync-failed'))}, 'replacement renamed');
            throw new Error('Fixture directory sync failure');
          };
          return file;
        };
      }
      if (${slowCommit && version === initialVersion}) {
        if (fixtureBoots.length > 1) {
          require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ version: fixtureElectron.app.getVersion(), pid: process.pid }));
          process.exit(125);
        }
        const files = require('node:fs/promises');
        const rename = files.rename.bind(files);
        files.rename = async (from, to) => {
          if (from === to + '.openkraken-update/next.AppImage') {
            setTimeout(() => fixtureElectron.app.quit(), 2500);
            await new Promise(resolve => setTimeout(resolve, 22000));
            require('node:fs').writeFileSync(${JSON.stringify(join(root, 'slow-commit'))}, 'rename resumed');
          }
          return rename(from, to);
        };
      }
      if (${stalledCommit && version === initialVersion} && !fixtureReturning) {
        fixtureElectron.app.once('will-quit', () => {
          const timer = global.setTimeout;
          global.setTimeout = (callback, ms, ...args) => {
            if (ms !== 600000) return timer(callback, ms, ...args);
            return timer(() => {
              require('node:fs').writeFileSync(${JSON.stringify(join(root, 'commit-timeout'))}, 'ten-minute deadline fired');
              callback(...args);
            }, 4000);
          };
        });
      }
      if (${interruptedCommit && version === initialVersion} && !fixtureReturning) {
        const fixtureFs = require('node:fs/promises');
        const originalRename = fixtureFs.rename;
        fixtureFs.rename = async (from, to) => {
          if (from === to + '.openkraken-update/next.AppImage') {
            if (${afterRename}) await originalRename(from, to);
            require('node:fs').writeFileSync(${JSON.stringify(failedMarker)}, ${JSON.stringify(afterRename ? 'after rename' : 'before rename')});
            if (!${stalledCommit}) process.kill(process.pid, 'SIGKILL');
            return new Promise(() => {});
          }
          return originalRename(from, to);
        };
      }
      if (fixtureReturning && ${failStartup}) fixtureElectron.app.commandLine.appendSwitch('remote-debugging-port', '0');
      if (${failStartup && version === replacementVersion}) {
        require('node:fs').writeFileSync(${JSON.stringify(failedMarker)}, 'replacement reached main');
        if (${delayedDescendant}) {
          const descendant = require('node:child_process').spawn('/bin/sleep', ['3'], { stdio: 'ignore' });
          if (!descendant.pid) throw new Error('Delayed descendant did not start');
          require('node:fs').writeFileSync(${JSON.stringify(descendantMarker)}, JSON.stringify({ pid: descendant.pid, started: Date.now() }));
          descendant.unref();
        }
        process.exit(23);
      }
      if (fixtureReturning && ${delayedDescendant}) {
        const descendant = JSON.parse(require('node:fs').readFileSync(${JSON.stringify(descendantMarker)}, 'utf8'));
        let stopped = false;
        try { stopped = /\\) [ZXx] /.test(require('node:fs').readFileSync('/proc/' + descendant.pid + '/stat', 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; stopped = true; }
        if (!stopped || Date.now() - descendant.started < 2900) throw new Error('Predecessor launched before delayed descendant stopped');
        require('node:fs').writeFileSync(${JSON.stringify(join(root, 'descendant-stopped'))}, 'verified before predecessor startup');
      }
      require('node:fs').appendFileSync(${JSON.stringify(join(root, 'boot.log'))}, JSON.stringify({ version: ${JSON.stringify(version)}, pid: process.pid, executable: process.execPath, image: process.env.APPIMAGE, appdir: process.env.APPDIR }) + '\\n');
      const fixtureRelaunch = fixtureElectron.app.relaunch.bind(fixtureElectron.app);
      fixtureElectron.app.relaunch = (options) => { require('node:fs').writeFileSync(${JSON.stringify(join(root, 'relaunch.json'))}, JSON.stringify(options)); return fixtureRelaunch(options); };
      const fixtureTls = require('node:tls');
      fixtureTls.setDefaultCACertificates([...fixtureTls.getCACertificates('default'), ${JSON.stringify(await readFile(cert, 'utf8'))}]);
      fixtureElectron.dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
      fixtureElectron.dialog.showMessageBoxSync = () => 0;
      fixtureElectron.dialog.showErrorBox = (title) => require('node:fs').writeFileSync(${JSON.stringify(join(root, 'install-error'))}, title);
      let fixtureCancelBeforeQuit = ${!helperUnavailable && version === initialVersion} && !fixtureReturning;
      const fixtureHandle = fixtureElectron.ipcMain.handle.bind(fixtureElectron.ipcMain);
      fixtureElectron.ipcMain.handle = (channel, listener) => fixtureHandle(channel, async (...args) => {
        let result = await listener(...args);
        if (fixtureCancelBeforeQuit && args[1]?.method === 'updatesInstall' && result.state?.phase === 'restart-ready') {
          fixtureCancelBeforeQuit = false;
          // Deliver cancellation in the microtask before the queued quit can run.
          result = await listener(args[0], { id: require('node:crypto').randomUUID(), method: 'updatesCancel' }, ...args.slice(2));
        }
        if ((${!failStartup && version === replacementVersion} || fixtureReturning) && args[1]?.method === 'updatesStarted') {
          require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ version: fixtureElectron.app.getVersion(), pid: process.pid, state: result }));
          if (!fixtureReturning || ${interruptedCommit}) setTimeout(() => fixtureElectron.app.quit(), 100);
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
    const name = `OpenKraken-${version}-linux-${process.arch}.AppImage`;
    const { artifact } = await buildAppImage(bundle, work, name, { version, testOnly: true });
    images.push(artifact);
    if (version === replacementVersion && unchangedImage)
      envelope = (await publishArtifact(images[0], version, 2)).envelope;
    const signed = await publishArtifact(
      artifact,
      version,
      version === replacementVersion && unchangedImage ? 3 : images.length,
    );
    receipts.push(signed.receipt);
    if (unchangedImage && version === replacementVersion) correctedEnvelope = signed.envelope;
    else envelope = signed.envelope;
  }
  const artifact = images[1];
  const initialArtifact = receipts[0].artifacts[0];
  const download = join(root, initialArtifact.name);
  const checksum = `${initialArtifact.sha256}  ${initialArtifact.name}\n`;
  const check = () =>
    execFileSync('sha256sum', ['--check', '--strict', '-'], {
      cwd: root,
      input: checksum,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  await writeFile(download, 'incomplete download');
  assert.throws(check, (error) => error.status === 1);
  await promisify(execFile)('curl', [
    '--fail',
    '--silent',
    '--show-error',
    '--cacert',
    cert,
    '--output',
    download,
    new URL(initialArtifact.name, config.feed).href,
  ]);
  check();
  console.log(
    'First AppImage matched the publisher receipt before launch; incomplete download rejected.',
  );
  const originalDigest = initialArtifact.sha256;
  const target = join(root, 'Installed OpenKraken.AppImage');
  await rename(download, target);
  await chmod(target, 0o755);
  const configHome = join(root, 'config');
  const profile = beta ? join(configHome, 'OpenKraken Beta') : join(root, 'profile');
  const stableUpdates = join(configHome, 'OpenKraken', 'updates');
  const args = ['--remote-debugging-port=0'];
  if (beta) {
    await mkdir(stableUpdates, { recursive: true, mode: 0o700 });
    await writeFile(join(stableUpdates, 'trusted-release.json'), 'stable fixture watermark');
  } else {
    await mkdir(profile);
    args.push(`--user-data-dir=${profile}`);
  }
  child = spawn(target, args, {
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, TMPDIR: root, XDG_CONFIG_HOME: configHome },
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
  if (beta) await expect(dialog.getByText(/Beta channel/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Check for updates' }).click();
  await dialog.getByRole('button', { name: 'Download AppImage' }).click();
  await expect(
    dialog.getByRole('button', { name: 'Install and restart', exact: true }),
  ).toBeVisible({ timeout: 30000 });
  if (unchangedImage) {
    await dialog.getByRole('button', { name: 'Install and restart', exact: true }).click();
    await expect(dialog).toContainText('This release contains the installed AppImage.', {
      timeout: 30000,
    });
    assert.equal(await sha256(target), originalDigest);
    await assert.rejects(stat(target + '.openkraken-update'), { code: 'ENOENT' });
    assert.deepEqual(JSON.parse(await readFile(join(root, 'boot.json'), 'utf8')), [initialVersion]);
    assert.equal(
      JSON.parse(await readFile(join(profile, 'updates/trusted-release.json'), 'utf8')).sequence,
      2,
    );
    envelope = correctedEnvelope;
    await dialog.getByRole('button', { name: 'Check for updates' }).click();
    await dialog.getByRole('button', { name: 'Download AppImage' }).click();
    await expect(
      dialog.getByRole('button', { name: 'Install and restart', exact: true }),
    ).toBeVisible({ timeout: 30000 });
    console.log(
      'An identical signed AppImage was rejected before restart. The corrected release downloaded in the same session.',
    );
  }
  let first = await page.evaluate(() =>
    window.openkraken.request({ id: crypto.randomUUID(), method: 'updatesRead' }),
  );
  assert.ok(first.state.installId);
  if (helperUnavailable) {
    await dialog.getByRole('button', { name: 'Install and restart', exact: true }).click();
    await expect(dialog.getByRole('alert')).toHaveText(
      'The update could not be prepared for restart.',
      { timeout: 30000 },
    );
    const current = await page.evaluate(() =>
      window.openkraken.request({ id: crypto.randomUUID(), method: 'updatesRead' }),
    );
    assert.equal(current.state.phase, 'verified');
    await assert.rejects(stat(join(root, 'install-error')), { code: 'ENOENT' });
    assert.ok(current.state.installId && current.state.installId !== first.state.installId);
    assert.equal(await sha256(target), originalDigest);
    await assert.rejects(stat(target + '.openkraken-update'), { code: 'ENOENT' });
    assert.deepEqual(JSON.parse(await readFile(join(root, 'boot.json'), 'utf8')), [initialVersion]);
    // A second install reaches preparation again instead of retaining the admission lock.
    const retried = await page.evaluate(
      (installId) =>
        window.openkraken.request({ id: crypto.randomUUID(), method: 'updatesInstall', installId }),
      current.state.installId,
    );
    assert.equal(retried.code, 'UPDATE_INSTALL');
    assert.equal(await sha256(target), originalDigest);
    await assert.rejects(stat(target + '.openkraken-update'), { code: 'ENOENT' });
    await expect(page.getByRole('button', { name: 'Updates', exact: true })).toBeVisible();
    console.log(
      'Packaged AppImage: unavailable restart helper preserved the open application and original image, discarded staging and released installation admission.',
    );
  } else {
    const cancelledBeforeQuit = await page.evaluate(
      (installId) =>
        window.openkraken.request({ id: crypto.randomUUID(), method: 'updatesInstall', installId }),
      first.state.installId,
    );
    assert.equal(cancelledBeforeQuit.state.phase, 'verified');
    assert.notEqual(cancelledBeforeQuit.state.installId, first.state.installId);
    await delay(100);
    const admitted = await page.evaluate(() =>
      window.openkraken.request({ id: crypto.randomUUID(), method: 'diagnosticsRead' }),
    );
    assert.equal(admitted.kind, 'diagnostics');
    assert.equal(await sha256(target), originalDigest);
    await assert.rejects(stat(target + '.openkraken-update'), { code: 'ENOENT' });
    first = cancelledBeforeQuit;
    console.log(
      'Cancellation before queued quit preserved the open app and released installation admission.',
    );
    // The first cancellation was injected through IPC. Reopen so the UI reads
    // its fresh installation identity without depending on the polling interval.
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'Updates', exact: true }).click();
    await expect(
      dialog.getByRole('button', { name: 'Install and restart', exact: true }),
    ).toBeEnabled();
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
    const started = JSON.parse(await waitForFile(marker, slowCommit ? 60000 : 30000));
    assert.equal(started.version, predecessorReturns ? initialVersion : replacementVersion);
    if (syncError) {
      assert.equal(await readFile(join(root, 'sync-failed'), 'utf8'), 'replacement renamed');
      console.log('The parent reported a directory sync failure after replacing the AppImage.');
    }
    if (slowCommit)
      assert.equal(await readFile(join(root, 'slow-commit'), 'utf8'), 'rename resumed');
    if (delayedDescendant)
      assert.equal(
        await readFile(join(root, 'descendant-stopped'), 'utf8'),
        'verified before predecessor startup',
      );
    assert.equal(started.state.kind, 'updates');
    assert.equal(started.state.state.channel, beta ? 'beta' : 'stable');
    if (beta)
      assert.equal(
        await readFile(join(stableUpdates, 'trusted-release.json'), 'utf8'),
        'stable fixture watermark',
      );
    assert.equal(started.state.state.error, null);
    assert.equal(
      await sha256(target),
      predecessorReturns ? originalDigest : await sha256(artifact),
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(root, 'boot.json'), 'utf8')),
      predecessorInstalled
        ? [initialVersion, initialVersion]
        : failStartup
          ? [initialVersion, replacementVersion, initialVersion]
          : [initialVersion, replacementVersion],
    );
    assert.equal(
      JSON.parse(await readFile(join(profile, 'updates/trusted-release.json'), 'utf8')).sequence,
      receipts[1].sequence,
    );
    await assert.rejects(stat(target + '.openkraken-update'), { code: 'ENOENT' });
    if (stalledCommit)
      assert.equal(
        await readFile(join(root, 'commit-timeout'), 'utf8'),
        'ten-minute deadline fired',
      );
    if (interruptedCommit) {
      assert.equal(
        await readFile(failedMarker, 'utf8'),
        afterRename ? 'after rename' : 'before rename',
      );
      assert.equal(started.state.state.recovery, null);
      assert.equal((await stat(target)).nlink, 1);
    }
    if (failStartup) {
      assert.equal(started.state.state.recovery, 'restored');
      await browser.close().catch(() => {});
      const port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0];
      assert.match(port, /^\d+$/);
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      const restoredPage = browser.contexts()[0].pages()[0];
      await restoredPage.getByRole('button', { name: 'Updates', exact: true }).click();
      const restoredDialog = restoredPage.getByRole('dialog', { name: 'App updates' });
      await expect(restoredDialog.getByRole('alert')).toHaveText(
        'An update failed to start and the previous version was restored.',
      );
      await restoredPage.screenshot({ path: 'test-results/appimage-recovery-notice.png' });
      await restoredDialog.getByRole('button', { name: 'Dismiss recovery notice' }).click();
      await expect(restoredDialog.getByRole('alert')).toHaveCount(0);
      await assert.rejects(stat(join(profile, 'updates/rollback-notice.json')), { code: 'ENOENT' });
    }
    await delay(500);
    console.log(
      stalledCommit
        ? 'Packaged AppImage: finalization deadline stopped a stalled commit; the verified predecessor reopened and cleaned staging.'
        : slowCommit
          ? 'Packaged AppImage: the 22-second commit survived repeated quit, launched the signed replacement and confirmed startup.'
          : interruptedCommit
            ? `Packaged AppImage: killed the parent ${afterRename ? 'after' : 'before'} rename, launched ${started.version}, cleaned staging and retained the release watermark.`
            : delayedDescendant
              ? 'Packaged AppImage: waited for the delayed descendant, restored the exact predecessor, and retained the release watermark.'
              : failStartup
                ? 'Packaged AppImage: failed replacement startup restored and launched the exact predecessor; startup cleanup and release watermark retention passed.'
                : 'Packaged AppImage: signed HTTPS download, cancelled unsaved-work restart, accepted install, new-version launch and recovery acknowledgement passed.',
    );
  }
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
