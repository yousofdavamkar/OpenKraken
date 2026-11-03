import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createFixture, fixtureGit } from '../../packages/test-fixtures/src/index.js';

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
