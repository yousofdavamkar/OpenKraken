import { _electron as electron, expect, test } from '@playwright/test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createFixture, fixtureGit } from '../../packages/test-fixtures/src/index.js';
test('a draft edited while a native commit hook runs survives successful commit cleanup', async () => {
  test.skip(process.platform === 'win32', 'Fixture hook uses a POSIX shell');
  const root = mkdtempSync(join(tmpdir(), 'openkraken-draft-e2e-'));
  const repo = createFixture(join(root, 'repo'));
  writeFileSync(join(repo, 'tracked.txt'), 'staged change\n');
  fixtureGit(repo, ['add', 'tracked.txt']);
  writeFileSync(
    join(repo, '.git/hooks/pre-commit'),
    '#!/bin/sh\ntouch .git/draft-hook-ready\nsleep 1\n',
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
    const message = page.getByRole('textbox', { name: 'Commit message', exact: true });
    await message.fill('Commit in progress');
    await page.getByRole('button', { name: 'Commit staged changes', exact: true }).click();
    await expect.poll(() => existsSync(join(repo, '.git/draft-hook-ready'))).toBe(true);
    await message.fill('Keep this next draft');
    await expect(page.getByText('Working tree clean', { exact: true })).toBeVisible();
    await expect(message).toHaveValue('Keep this next draft');
    expect(fixtureGit(repo, ['log', '-1', '--format=%s'])).toBe('Commit in progress');
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
