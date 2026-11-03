import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createFixture, fixtureGit } from '../../packages/test-fixtures/src/index.js';

test('the live renderer blocks script execution, embedded documents and direct network access', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-csp-'));
  const probeName = `security-probe-${crypto.randomUUID()}.js`;
  const probe = resolve('apps/desktop/dist/renderer', probeName);
  writeFileSync(
    probe,
    `
    window.securityProbe = { violations: [], evalBlocked: false, functionBlocked: false };
    document.addEventListener('securitypolicyviolation', event => {
      window.securityProbe.violations.push(event.effectiveDirective);
    });
    try { eval('window.dynamicScriptRan = true'); } catch { window.securityProbe.evalBlocked = true; }
    try { new Function('window.dynamicScriptRan = true')(); } catch { window.securityProbe.functionBlocked = true; }
    const inline = document.createElement('script');
    inline.textContent = 'window.inlineScriptRan = true';
    document.head.append(inline);
    fetch('https://example.invalid/security-probe').catch(() => {});
    const script = document.createElement('script');
    script.src = 'https://example.invalid/security-probe.js';
    document.head.append(script);
    const frame = document.createElement('iframe');
    frame.src = './index.html';
    document.body.append(frame);
    try { new Worker('data:text/javascript,postMessage(1)'); } catch {}
    window.securityProbe.popupBlocked = window.open('https://example.invalid/') === null;
    `,
  );
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await expect(
      page.getByRole('button', { name: 'Open a repository', exact: true }),
    ).toBeVisible();
    await page.evaluate(
      (name) =>
        new Promise<void>((resolve, reject) => {
          const script = document.createElement('script');
          script.src = './' + name;
          script.onload = () => resolve();
          script.onerror = () => reject(new Error('Security fixture failed to load'));
          document.head.append(script);
        }),
      probeName,
    );
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, 'securityProbe')))
      .toMatchObject({
        evalBlocked: true,
        functionBlocked: true,
        popupBlocked: true,
        violations: expect.arrayContaining([
          'script-src',
          'script-src-elem',
          'connect-src',
          'frame-src',
          'worker-src',
        ]),
      });
    expect(
      await page.evaluate(() => ({
        inline: Reflect.get(window, 'inlineScriptRan'),
        dynamic: Reflect.get(window, 'dynamicScriptRan'),
        require: typeof Reflect.get(window, 'require'),
        process: typeof Reflect.get(window, 'process'),
      })),
    ).toEqual({
      inline: undefined,
      dynamic: undefined,
      require: 'undefined',
      process: 'undefined',
    });
    expect(app.windows()).toHaveLength(1);
  } finally {
    await app.close();
    rmSync(probe, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('a second window cannot invoke requests or cancellation even with the exact app document and preload', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-sender-'));
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await expect(
      page.getByRole('button', { name: 'Open a repository', exact: true }),
    ).toBeVisible();
    const outcomes = await app.evaluate(async ({ BrowserWindow }, preload) => {
      const url = BrowserWindow.getAllWindows()[0]!.webContents.getURL();
      const untrusted = new BrowserWindow({
        show: false,
        webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false },
      });
      try {
        await untrusted.loadURL(url);
        return await untrusted.webContents.executeJavaScript(`(async () => {
            const outcomes = [];
            for (const invoke of [
              () => window.openkraken.request({ id: crypto.randomUUID(), method: 'crashReporting' }),
              () => window.openkraken.cancel(crypto.randomUUID()),
            ]) {
              try { await invoke(); outcomes.push('accepted'); }
              catch (error) { outcomes.push(error.message); }
            }
            return outcomes;
          })()`);
      } finally {
        untrusted.destroy();
      }
    }, resolve('apps/desktop/dist/preload.cjs'));
    expect(outcomes).toEqual([
      expect.stringContaining('Untrusted IPC sender'),
      expect.stringContaining('Untrusted IPC sender'),
    ]);
    expect(
      await page.evaluate(() =>
        window.openkraken.request({ id: crypto.randomUUID(), method: 'crashReporting' }),
      ),
    ).toMatchObject({ kind: 'crashReporting' });
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('failed native hooks keep URL credentials and parameters out of renderer diagnostics', async () => {
  test.skip(process.platform === 'win32', 'Fixture hook uses a POSIX shell');
  const root = mkdtempSync(join(tmpdir(), 'openkraken-security-'));
  const repo = createFixture(join(root, 'repo'));
  writeFileSync(join(repo, 'tracked.txt'), 'staged change\n');
  fixtureGit(repo, ['add', 'tracked.txt']);
  writeFileSync(
    join(repo, '.git/hooks/pre-commit'),
    '#!/bin/sh\necho "Hook rejected https://private-user:private-password@example.test/repo?token=private-query#private-fragment" >&2\nexit 1\n',
    { mode: 0o755 },
  );
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, repo);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    await page
      .getByRole('textbox', { name: 'Commit message', exact: true })
      .fill('Rejected commit');
    await page.getByRole('button', { name: 'Commit staged changes', exact: true }).click();
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('Hook rejected');
    await expect(alert).toContainText(
      'https://[credentials]@example.test/repo[redacted parameters]',
    );
    expect(await page.locator('body').innerText()).not.toMatch(
      /private-(user|password|query|fragment)/,
    );
    await expect(page.getByRole('textbox', { name: 'Commit message', exact: true })).toHaveValue(
      'Rejected commit',
    );
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
