import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createFixture, fixtureGit } from '../../packages/test-fixtures/src/index.js';

test('a failed initial snapshot can be reopened and observes subsequent native changes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-watcher-startup-'));
  const repository = createFixture(join(root, 'repo'), 'linear', 10);
  const broken = join(repository, '.git', 'refs', 'tags', 'missing-object');
  writeFileSync(broken, `${'1'.repeat(40)}\n`);
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, repository);
    const failed = await page.evaluate(() =>
      window.openkraken.request({ id: crypto.randomUUID(), method: 'open' }),
    );
    expect(failed.kind).toBe('error');
    rmSync(broken);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    await expect(page.getByTestId('commit-graph')).toBeVisible();
    await expect(page.getByText('Watching for changes', { exact: true })).toBeVisible();
    fixtureGit(repository, ['branch', 'after-retry']);
    await expect(page.locator('.refs .ref', { hasText: 'after-retry' })).toBeVisible();
    writeFileSync(join(repository, 'after-retry.txt'), 'observed');
    await expect(
      page.getByRole('button', { name: 'Stage after-retry.txt', exact: true }),
    ).toBeVisible();
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const failure of ['missing-ref-object', 'missing-parent'] as const)
  test(`a failed repository switch (${failure}) keeps the displayed repository watched and pageable`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'openkraken-watcher-switch-'));
    const active = createFixture(join(root, 'active'), 'linear', 2200);
    const invalid = createFixture(join(root, 'invalid'), 'linear', 10);
    const broken = join(invalid, '.git', 'refs', 'tags', 'missing-object');
    const originalHead = fixtureGit(invalid, ['rev-parse', 'HEAD']);
    if (failure === 'missing-ref-object') writeFileSync(broken, `${'1'.repeat(40)}\n`);
    else {
      fixtureGit(invalid, ['config', '--remove-section', 'branch.main']);
      const tree = fixtureGit(invalid, ['rev-parse', 'HEAD^{tree}']);
      const invalidHead = fixtureGit(
        invalid,
        ['hash-object', '-t', 'commit', '-w', '--stdin'],
        `tree ${tree}\nparent ${'1'.repeat(40)}\nauthor Fixture <fixture@example.test> 1700000000 +0000\ncommitter Fixture <fixture@example.test> 1700000000 +0000\n\nMissing parent\n`,
      );
      fixtureGit(invalid, ['update-ref', 'refs/heads/main', invalidHead]);
    }
    const app = await electron.launch({
      args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
    });
    try {
      const page = await app.firstWindow();
      const choose = (path: string) =>
        app.evaluate(({ dialog }, selected) => {
          dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
        }, path);
      await choose(active);
      await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
      await expect(page.getByText('Watching for changes', { exact: true })).toBeVisible();
      await page.getByRole('checkbox', { name: 'Refresh on focus', exact: true }).uncheck();
      await choose(invalid);
      await page.getByRole('button', { name: 'Open repository', exact: true }).click();
      await expect(page.getByRole('alert')).toBeVisible();
      await expect(page.getByRole('heading', { name: 'active', exact: true })).toBeVisible();
      await expect(page.getByTestId('commit-count')).toHaveText('2,000 commits · more available');
      await page.getByRole('button', { name: 'Load more commits', exact: true }).click();
      await expect(page.getByTestId('commit-count')).toHaveText('2,200 commits');
      fixtureGit(active, ['branch', 'after-failed-switch']);
      await expect(page.locator('.refs .ref', { hasText: 'after-failed-switch' })).toBeVisible();
      writeFileSync(join(active, 'still-observed.txt'), 'still observed');
      await expect(
        page.getByRole('button', { name: 'Stage still-observed.txt', exact: true }),
      ).toBeVisible();
      if (failure === 'missing-ref-object') rmSync(broken);
      else fixtureGit(invalid, ['update-ref', 'refs/heads/main', originalHead]);
      await choose(invalid);
      await page.getByRole('button', { name: 'Open repository', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'invalid', exact: true })).toBeVisible();
      await expect(page.getByText('Watching for changes', { exact: true })).toBeVisible();
      fixtureGit(invalid, ['branch', 'after-successful-switch']);
      await expect(
        page.locator('.refs .ref', { hasText: 'after-successful-switch' }),
      ).toBeVisible();
    } finally {
      await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
