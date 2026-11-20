import { _electron as electron, expect, test } from '@playwright/test';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { reportingTest } from './reporting-fixture.js';

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
    await expect(readFile(join(profile, 'reporting-session.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    await app.close();
    await rm(profile, { recursive: true, force: true });
  }
});

// Inject while the bundled desktop module constructs its initial document URL.
function duringDesktopLoad(trigger: string) {
  return `const url = require('node:url'), original = url.pathToFileURL;
    url.pathToFileURL = function (path, ...args) {
      if (typeof path === 'string' && path.endsWith(require('node:path').join('renderer', 'index.html'))) {
        url.pathToFileURL = original;
        ${trigger}
      }
      return original(path, ...args);
    };`;
}

for (const failure of [
  {
    name: 'a main exception',
    component: 'main',
    reason: 'unhandled-exception',
    trigger: "throw new Error('PRIVATE startup fixture');",
  },
  {
    name: 'a GPU termination event',
    component: 'gpu',
    reason: 'crashed',
    trigger:
      "require('electron').app.emit('child-process-gone', {}, { type: 'GPU', name: 'PRIVATE device', reason: 'crashed' });",
  },
  {
    name: 'a GPU termination event while loading desktop modules',
    component: 'gpu',
    reason: 'crashed',
    duringModuleLoad: true,
    trigger:
      "require('electron').app.emit('child-process-gone', {}, { type: 'GPU', name: 'PRIVATE early GPU', reason: 'crashed' });",
  },
  {
    name: 'a sandboxed preload exception',
    component: 'renderer',
    reason: 'unhandled-exception',
    trigger: `require('electron').app.whenReady().then(() => {
      require('electron').session.defaultSession.registerPreloadScript({
        type: 'frame',
        filePath: require('node:path').join(__dirname, 'PRIVATE-preload.cjs'),
      });
    });`,
  },
]) {
  reportingTest(
    `${failure.name} during startup follows consent from the previous session`,
    async ({ receiver }) => {
      const { root, received, launch } = receiver;
      const descriptor = join(root, 'app/package.json');
      const metadata = JSON.parse(await readFile(descriptor, 'utf8'));
      if (failure.component === 'renderer')
        await writeFile(join(root, 'app/PRIVATE-preload.cjs'), "throw Error('PRIVATE exception');");
      await writeFile(
        join(root, 'app/startup-failure.cjs'),
        [
          "require('electron').dialog.showErrorBox = () => {};",
          ...(failure.duringModuleLoad ? [duringDesktopLoad(failure.trigger)] : []),
          `require(${JSON.stringify(metadata.main)});`,
          ...(failure.duringModuleLoad ? [] : [`process.nextTick(() => { ${failure.trigger} });`]),
        ].join('\n'),
      );
      await writeFile(descriptor, JSON.stringify({ ...metadata, main: 'startup-failure.cjs' }));

      let app = await launch();
      try {
        const reportingDialog = async () => {
          const page = await app.firstWindow();
          await page.getByRole('button', { name: 'Crash reporting', exact: true }).click();
          return page.getByRole('dialog', { name: 'Crash reporting' });
        };
        let dialog = await reportingDialog();
        const checkbox = { name: 'Send crash summaries' };
        await dialog.getByRole('checkbox', checkbox).check();
        await dialog.getByRole('button', { name: 'Apply' }).click();
        await expect(dialog.getByRole('status')).toHaveText('Crash reporting is on.');
        await app.close();
        expect(received).toHaveLength(0);

        app = await launch();
        dialog = await reportingDialog();
        await expect.poll(() => received.length).toBe(1);
        const report = received[0]!;
        expect(report.body).not.toContain('PRIVATE');
        expect(JSON.parse(report.body.trim().split('\n')[2]!).tags).toMatchObject({
          process: failure.component,
          reason: failure.reason,
        });
        await dialog.getByRole('checkbox', checkbox).uncheck();
        await dialog.getByRole('button', { name: 'Apply' }).click();
        await expect(dialog.getByRole('status')).toHaveText('Crash reporting is off.');
        await app.close();

        app = await launch();
        dialog = await reportingDialog();
        await expect(dialog.getByRole('checkbox', checkbox)).not.toBeChecked();
      } finally {
        await app.close();
      }
      expect(received).toHaveLength(1);
    },
  );
}

for (const failure of [
  {
    name: 'a fatal desktop initialization error',
    reason: 'unhandled-exception',
    trigger: duringDesktopLoad("throw new Error('PRIVATE bootstrap exception');"),
  },
  {
    name: 'a missing initial renderer document',
    reason: 'unhandled-rejection',
    trigger: `const { BrowserWindow } = require('electron');
      const load = BrowserWindow.prototype.loadFile;
      BrowserWindow.prototype.loadFile = function () {
        return load.call(this, require('node:path').join(__dirname, 'PRIVATE-missing.html'));
      };`,
  },
  {
    name: 'a missing renderer entry module',
    reason: 'unhandled-rejection',
    damage: 'missing',
  },
  {
    name: 'a renderer entry module that throws during evaluation',
    reason: 'unhandled-rejection',
    damage: 'exception',
  },
  {
    name: 'a renderer document missing its React root',
    reason: 'unhandled-rejection',
    damage: 'missing-root',
  },
])
  reportingTest(
    `${failure.name} releases the profile and honors saved consent`,
    async ({ receiver }) => {
      const { root, received, launch } = receiver;
      const directory = join(root, 'broken-app');
      const profile = join(root, 'profile');
      const metadata = JSON.parse(await readFile(join(root, 'app/package.json'), 'utf8'));
      await mkdir(directory);
      let main = metadata.main;
      if (failure.damage) {
        const dist = join(directory, 'dist');
        await cp(dirname(main), dist, { recursive: true });
        main = join(dist, basename(main));
        const renderer = join(dist, 'renderer');
        const html = await readFile(join(renderer, 'index.html'), 'utf8');
        const entries = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)];
        expect(entries).toHaveLength(1);
        const entry = join(renderer, entries[0]![1]!);
        if (failure.damage === 'missing-root') {
          expect(html).toContain('<div id="root"></div>');
          await writeFile(join(renderer, 'index.html'), html.replace('<div id="root"></div>', ''));
        } else if (failure.damage === 'missing') await rm(entry);
        else await writeFile(entry, "throw new Error('PRIVATE renderer entry exception')");
      }
      await writeFile(
        join(directory, 'package.json'),
        JSON.stringify({ ...metadata, main: 'failure.cjs' }),
      );
      await writeFile(
        join(directory, 'failure.cjs'),
        `
    const { dialog } = require('electron');
    dialog.showErrorBox = (title) => require('node:fs').writeFileSync(require('node:path').join(__dirname, 'error-title'), title);
    ${failure.trigger ?? ''}
    require(${JSON.stringify(main)});
  `,
      );
      const failStartup = async () => {
        const { NODE_TLS_REJECT_UNAUTHORIZED: _override, ...env } = process.env;
        await expect(
          promisify(execFile)(
            createRequire(import.meta.url)('electron') as string,
            [directory, `--user-data-dir=${profile}`],
            {
              env: { ...env, NODE_EXTRA_CA_CERTS: join(root, 'cert.pem') },
              timeout: 12000,
              killSignal: 'SIGKILL',
            },
          ),
        ).rejects.toMatchObject({
          code: 1,
          killed: false,
        });
        const title = join(directory, 'error-title');
        expect(await readFile(title, 'utf8')).toBe('OpenKraken could not start');
        await rm(title);
        const segment = await readFile(join(profile, 'diagnostics/diagnostics-0.json'), 'utf8');
        expect(segment).not.toContain('PRIVATE');
        expect(segment).not.toContain(root);
        expect(JSON.parse(segment).entries).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: 'process', component: 'main', reason: failure.reason }),
          ]),
        );
        await expect(readFile(join(profile, 'reporting-session.json'))).rejects.toMatchObject({
          code: 'ENOENT',
        });
      };
      const saveConsent = async (enabled: boolean) => {
        const app = await launch();
        try {
          const page = await app.firstWindow();
          await page.getByRole('button', { name: 'Crash reporting', exact: true }).click();
          const dialog = page.getByRole('dialog', { name: 'Crash reporting' });
          await dialog.getByRole('checkbox', { name: 'Send crash summaries' }).setChecked(enabled);
          await dialog.getByRole('button', { name: 'Apply' }).click();
          await expect(dialog.getByRole('status')).toHaveText(
            `Crash reporting is ${enabled ? 'on' : 'off'}.`,
          );
        } finally {
          await app.close();
        }
      };
      await failStartup();
      expect(received).toHaveLength(0);
      await saveConsent(true);
      await failStartup();
      expect(received).toHaveLength(1);
      const envelope = received[0]!.body;
      expect(envelope).not.toContain('PRIVATE');
      expect(envelope).not.toContain(root);
      expect(JSON.parse(envelope.trim().split('\n')[2]!).tags).toMatchObject({
        process: 'main',
        reason: failure.reason,
      });
      await saveConsent(false);
      await failStartup();
      expect(received).toHaveLength(1);
    },
  );

for (const busy of [false, true])
  test(
    busy
      ? 'the first startup acknowledgement survives a full request queue'
      : 'a delayed theme read lets the document load before the desktop acknowledges startup',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'openkraken-startup-theme-'));
      let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
      try {
        await writeFile(
          join(root, 'package.json'),
          JSON.stringify({ name: 'openkraken', version: '0.1.0', main: 'delay.cjs' }),
        );
        await writeFile(
          join(root, 'delay.cjs'),
          `
      const { ipcMain, dialog } = require('electron');
      const handle = ipcMain.handle.bind(ipcMain);
      globalThis.pickers = [];
      dialog.showOpenDialog = () => new Promise(resolve => globalThis.pickers.push(resolve));
      dialog.showErrorBox = (title) => require('node:fs').writeFileSync(require('node:path').join(__dirname, 'error-title'), title);
      ipcMain.handle = (channel, handler) => handle(channel, async (event, request, ...args) => {
        if (request.method === 'appearancePreferences' && !globalThis.resumeAppearance)
          await new Promise(resolve => { globalThis.resumeAppearance = resolve; });
        const result = await handler(event, request, ...args);
        if (request.method === 'updatesStarted') globalThis.startupAcknowledged = result.kind;
        return result;
      });
      require(${JSON.stringify(resolve('apps/desktop/dist/main.cjs'))});
    `,
        );
        app = await electron.launch({ args: [root, `--user-data-dir=${join(root, 'profile')}`] });
        const page = await app.firstWindow();
        await page.waitForLoadState('load');
        await expect
          .poll(() => app!.evaluate(() => typeof Reflect.get(globalThis, 'resumeAppearance')))
          .toBe('function');
        expect(await page.locator('#root > *').count()).toBe(0);
        expect(
          await app.evaluate(() => Reflect.get(globalThis, 'startupAcknowledged')),
        ).toBeUndefined();
        if (busy) {
          await page.evaluate(() => {
            for (let i = 0; i < 8; i++)
              void window.openkraken.request({ id: crypto.randomUUID(), method: 'open' });
          });
          await expect
            .poll(() => app!.evaluate(() => Reflect.get(globalThis, 'pickers').length))
            .toBe(8);
        }
        await app.evaluate(() => Reflect.get(globalThis, 'resumeAppearance')());
        await expect(
          page.getByRole('button', { name: 'Open a repository', exact: true }),
        ).toBeVisible();
        await expect
          .poll(() => app!.evaluate(() => Reflect.get(globalThis, 'startupAcknowledged')))
          .toBe('updates');
        if (busy) {
          const repeated = await page.evaluate(() =>
            window.openkraken.request({ id: crypto.randomUUID(), method: 'updatesStarted' }),
          );
          expect(repeated).toMatchObject({ kind: 'error', code: 'BUSY' });
          await app.evaluate(() => {
            for (const done of Reflect.get(globalThis, 'pickers'))
              done({ canceled: true, filePaths: [] });
          });
        }
        await expect(readFile(join(root, 'error-title'))).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        await app?.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

test('quitting during the first document load exits normally', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openkraken-quit-loading-'));
  const title = join(root, 'error-title');
  try {
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ name: 'openkraken', version: '0.1.0', main: 'quit.cjs' }),
    );
    await writeFile(
      join(root, 'quit.cjs'),
      `
      const { app, BrowserWindow, dialog } = require('electron');
      dialog.showErrorBox = (title) => require('node:fs').writeFileSync(${JSON.stringify(title)}, title);
      const load = BrowserWindow.prototype.loadFile;
      BrowserWindow.prototype.loadFile = function (...args) {
        this.webContents.once('did-start-loading', () => {
          require('node:fs').writeFileSync(require('node:path').join(__dirname, 'loading'), 'started');
          app.quit();
        });
        return load.apply(this, args);
      };
      require(${JSON.stringify(resolve('apps/desktop/dist/main.cjs'))});
    `,
    );
    await promisify(execFile)(
      createRequire(import.meta.url)('electron') as string,
      [root, `--user-data-dir=${join(root, 'profile')}`],
      { timeout: 12000, killSignal: 'SIGKILL' },
    );
    expect(await readFile(join(root, 'loading'), 'utf8')).toBe('started');
    await expect(readFile(title)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

reportingTest('crashes and interrupted sessions respect consent', async ({ receiver }) => {
  const { root, address, launch, received } = receiver;
  reportingTest.setTimeout(90000);
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    const crash = async () =>
      app!.evaluate(async ({ BrowserWindow }) => {
        const contents = BrowserWindow.getAllWindows()[0]!.webContents;
        const gone = new Promise<string>((resolve) =>
          contents.once('render-process-gone', (_event, details) => resolve(details.reason)),
        );
        contents.forcefullyCrashRenderer();
        return gone;
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
    const consent = dialog.getByRole('checkbox', { name: 'Send crash summaries' });
    await expect(consent).toBeFocused();
    await page.keyboard.press('Space');
    await expect(consent).toBeChecked();
    await page.keyboard.press('Tab');
    const apply = dialog.getByRole('button', { name: 'Apply' });
    await expect(apply).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dialog.getByRole('status')).toHaveText('Crash reporting is on.');
    await expect(apply).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Crash reporting', exact: true })).toBeFocused();
    await app.close();

    app = await launch();
    page = await app.firstWindow();
    await page.getByRole('button', { name: 'Crash reporting', exact: true }).click();
    await expect(page.getByRole('checkbox', { name: 'Send crash summaries' })).toBeChecked();
    await page.screenshot({ path: test.info().outputPath('crash-reporting-consent.png') });
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.evaluate(() => {
      setTimeout(() => {
        throw new Error('PRIVATE-renderer-source:/home/person/repo');
      }, 0);
    });
    await expect.poll(() => received.length).toBe(1);
    expect(JSON.parse(received[0]!.body.trim().split('\n')[2]!).tags).toEqual({
      process: 'renderer',
      reason: 'unhandled-exception',
      os: process.platform,
      arch: process.arch,
    });
    expect(received[0]!.body).not.toContain('PRIVATE');
    received.splice(0);
    await page.evaluate(() => {
      void Promise.reject('PRIVATE-rejection-token');
    });
    await expect.poll(() => received.length).toBe(1);
    expect(JSON.parse(received[0]!.body.trim().split('\n')[2]!).tags.reason).toBe(
      'unhandled-rejection',
    );
    expect(received[0]!.body).not.toContain('PRIVATE');
    received.splice(0);
    await app.evaluate(({ dialog }) => {
      dialog.showErrorBox = () => {};
      setTimeout(() => {
        throw new Error('PRIVATE-main-error-token');
      }, 0);
    });
    await expect.poll(() => received.length).toBe(1);
    expect(JSON.parse(received[0]!.body.trim().split('\n')[2]!).tags).toEqual({
      process: 'main',
      reason: 'unhandled-exception',
      os: process.platform,
      arch: process.arch,
    });
    expect(received[0]!.body).not.toContain('PRIVATE');
    received.splice(0);
    if (process.platform !== 'win32') {
      const utilityFailure = await app.evaluate(async ({ app }) => {
        const service = app.getAppMetrics().find((metric) => metric.name === 'OpenKraken Git');
        if (!service) throw new Error('Missing Git utility');
        const gone = new Promise<{ reason: string; name?: string; serviceName?: string }>(
          (resolve) =>
            app.once('child-process-gone', (_event, details) =>
              resolve({
                reason: details.reason,
                name: details.name,
                serviceName: details.serviceName,
              }),
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
        os: process.platform,
        arch: process.arch,
      });
      received.splice(0);
    }
    const rendererReason = await crash();
    expect(['crashed', 'killed']).toContain(rendererReason);
    if (process.platform === 'linux') expect(rendererReason).toBe('crashed');
    if (rendererReason === 'crashed') {
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
        tags: {
          process: 'renderer',
          reason: 'crashed',
          os: process.platform,
          arch: process.arch,
        },
      });
      expect(received[0]!.body).not.toContain(root);
    }
    await app.close();
    expect(received).toHaveLength(rendererReason === 'crashed' ? 1 : 0);
    await expect(readFile(join(root, 'profile/reporting-session.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    received.splice(0);

    app = await launch();
    await app.firstWindow();
    const processHandle = app.process();
    const exited = new Promise<void>((resolve) => processHandle.once('exit', () => resolve()));
    expect(processHandle.kill('SIGKILL')).toBe(true);
    await exited;
    app = undefined;
    expect(received).toHaveLength(0);
    app = await launch();
    await app.firstWindow();
    await expect.poll(() => received.length).toBe(1);
    const recovered = JSON.parse(received[0]!.body.trim().split('\n')[2]!);
    expect(recovered.tags).toEqual({
      process: 'main',
      reason: 'unclean-exit',
      os: process.platform,
      arch: process.arch,
    });
    expect(recovered.level).toBe('warning');
    expect(Object.keys(recovered).sort()).toEqual([
      'event_id',
      'level',
      'message',
      'platform',
      'release',
      'tags',
    ]);
    await app.close();

    app = await launch();
    page = await app.firstWindow();
    const clean = await page.evaluate(() =>
      window.openkraken.request({ id: crypto.randomUUID(), method: 'crashReporting' }),
    );
    expect(clean).toMatchObject({ kind: 'crashReporting', state: { delivery: 'idle' } });
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
  }
});

for (const when of ['while running', 'before startup']) {
  reportingTest(
    `revoking reporting survives restart when the session marker changes ${when}`,
    async ({ receiver }) => {
      reportingTest.setTimeout(60000);
      const { root, launch, received } = receiver;
      let app = await launch();
      try {
        let page = await app.firstWindow();
        const settings = () =>
          page.getByRole('button', { name: 'Crash reporting', exact: true }).click();
        const dialog = () => page.getByRole('dialog', { name: 'Crash reporting' });
        const checkbox = () => dialog().getByRole('checkbox', { name: 'Send crash summaries' });
        const apply = () => dialog().getByRole('button', { name: 'Apply' }).click();

        await settings();
        await checkbox().check();
        await apply();
        await expect(dialog().getByRole('status')).toHaveText('Crash reporting is on.');
        await page.evaluate(() => {
          void Promise.reject('PRIVATE-reporting-fixture');
        });
        await expect.poll(() => received.length).toBe(1);
        expect(JSON.parse(received[0]!.body.trim().split('\n')[2]!).tags).toEqual({
          process: 'renderer',
          reason: 'unhandled-rejection',
          os: process.platform,
          arch: process.arch,
        });
        expect(received[0]!.body).not.toContain('PRIVATE');

        const marker = join(root, 'profile/reporting-session.json');
        if (when === 'before startup') await app.close();
        const changed =
          when === 'before startup'
            ? 'unreadable session'
            : JSON.stringify({
                ...JSON.parse(await readFile(marker, 'utf8')),
                session: randomUUID(),
              });
        await writeFile(marker, changed);
        if (when === 'before startup') {
          app = await launch();
          page = await app.firstWindow();
          await settings();
          await expect(checkbox()).not.toBeChecked();
          await expect(dialog().getByRole('alert')).toContainText('off for this launch');
        } else {
          await checkbox().uncheck();
        }
        await apply();
        await expect(dialog().getByRole('status')).toHaveText('Crash reporting is off.');
        await expect(dialog().getByRole('alert')).toContainText('session marker may remain');
        expect(await readFile(marker, 'utf8')).toBe(changed);

        // Exit without the clean-shutdown handler after the opt-out was acknowledged.
        const closed = app.waitForEvent('close');
        await app.evaluate(({ app }) => {
          setTimeout(() => app.exit(0), 10);
        });
        await closed;
        app = await launch();
        page = await app.firstWindow();
        await settings();
        await expect(checkbox()).not.toBeChecked();
        await page.evaluate(() => {
          void Promise.reject('PRIVATE-after-restart');
        });
        await app.close();
        expect(received).toHaveLength(1);
        expect(await readFile(marker, 'utf8')).toBe(changed);
      } finally {
        await app.close().catch(() => {});
      }
    },
  );
}

reportingTest('a failed opt-in does not enable reporting on restart', async ({ receiver }) => {
  const { root, launch, received } = receiver;
  let app = await launch();
  try {
    let page = await app.firstWindow();
    const settings = () =>
      page.getByRole('button', { name: 'Crash reporting', exact: true }).click();
    const dialog = () => page.getByRole('dialog', { name: 'Crash reporting' });
    const marker = join(root, 'profile/reporting-session.json');
    await settings();
    await writeFile(marker, 'unreadable session');
    await dialog().getByRole('checkbox', { name: 'Send crash summaries' }).check();
    await dialog().getByRole('button', { name: 'Apply' }).click();
    await expect(dialog().getByText(/off for this launch/)).toBeVisible();
    await expect(dialog().getByRole('checkbox')).not.toBeChecked();
    await expect(dialog().getByRole('button', { name: 'Apply' })).toBeEnabled();
    await expect(dialog().getByRole('button', { name: 'Apply' })).toBeFocused();
    await expect(readFile(join(root, 'profile/crash-reporting.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await app.close();
    await rm(marker);
    app = await launch();
    page = await app.firstWindow();
    await settings();
    await expect(dialog().getByRole('checkbox')).not.toBeChecked();
    expect(received).toHaveLength(0);
  } finally {
    await app.close().catch(() => {});
  }
});
