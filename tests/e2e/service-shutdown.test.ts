import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('the application exits normally after its idle Git service crashes', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'openkraken-service-exit-'));
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${profile}`],
  });
  const desktopProcess = app.process();
  let closing: Promise<void> | undefined;
  try {
    await app.firstWindow();
    await app.evaluate(({ app }) => {
      const service = app.getAppMetrics().find((metric) => metric.name === 'OpenKraken Git');
      if (!service) throw new Error('Missing Git service');
      process.kill(service.pid, 'SIGKILL');
    });
    await expect
      .poll(() =>
        app.evaluate(({ app }) =>
          app.getAppMetrics().some((metric) => metric.name === 'OpenKraken Git'),
        ),
      )
      .toBe(false);
    closing = app.close();
    await expect.poll(() => desktopProcess.exitCode).toBe(0);
    await closing;
  } finally {
    if (desktopProcess.exitCode === null && desktopProcess.signalCode === null)
      desktopProcess.kill('SIGKILL');
    await closing?.catch(() => {});
    rmSync(profile, { recursive: true, force: true });
  }
});
