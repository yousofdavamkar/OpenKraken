import { _electron as electron, expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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
    await dialog.getByRole('checkbox', { name: 'Send crash summaries' }).check();
    await dialog.getByRole('button', { name: 'Apply' }).click();
    await expect(dialog.getByRole('status')).toHaveText('Crash reporting is on.');
    await dialog.getByRole('button', { name: 'Close' }).click();
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
