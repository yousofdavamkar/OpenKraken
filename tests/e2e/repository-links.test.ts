import { _electron as electron, expect, test } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createFixture } from '../../packages/test-fixtures/src/index.js';

const link = (path: string) => `openkraken://repo?path=${encodeURIComponent(path)}`;

test('cold-start links wait for review and cancellation leaves the repository unopened', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-link-cold-'));
  const repo = createFixture(join(root, 'space and ünicode repo'));
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`, link(repo)],
  });
  try {
    const page = await app.firstWindow();
    await expect(
      page.getByRole('heading', { name: 'A clear view of your history.' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Review repository link', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Open linked repository', exact: true });
    await expect(dialog).toContainText(repo);
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
    await page.screenshot({ path: 'test-results/repository-link-consent.png' });
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Review repository link' })).toHaveCount(0);
    await expect(
      page.getByRole('heading', { name: 'A clear view of your history.' }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole('button', { name: 'Open a repository', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Review repository link' })).toHaveCount(0);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a second process delivers one immutable proposal and acceptance opens it exactly once', async () => {
  test.skip(process.platform === 'darwin', 'macOS dispatches protocol links through open-url');
  const root = mkdtempSync(join(tmpdir(), 'openkraken-link-resident-'));
  const repo = createFixture(join(root, 'reviewed repository'));
  const other = createFixture(join(root, 'unreviewed repository'));
  const args = [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`];
  const app = await electron.launch({ args });
  try {
    const page = await app.firstWindow();
    await expect(
      page.getByRole('button', { name: 'Open a repository', exact: true }),
    ).toBeVisible();
    const deliver = (uri: string) =>
      promisify(execFile)(app.process().spawnfile, [...args, uri], { timeout: 10000 });
    await deliver(link(repo));
    await page.getByRole('button', { name: 'Review repository link', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Open linked repository', exact: true });
    await expect(dialog).toContainText(repo);
    const proposal = await page.evaluate(() =>
      window.openkraken.request({ id: crypto.randomUUID(), method: 'repositoryLink' }),
    );
    if (proposal.kind !== 'repositoryLink' || !proposal.link) throw new Error('Missing proposal');
    await deliver(link(other));
    await expect(dialog).toContainText(repo);
    await expect(dialog).not.toContainText(other);
    await dialog.getByRole('button', { name: 'Open repository', exact: true }).click();
    await expect(page.getByTestId('head')).toHaveText('main');
    await expect(
      page.getByRole('heading', { name: 'reviewed repository', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Review repository link' })).toHaveCount(0);
    const state = await page.evaluate(
      (linkId) =>
        window.openkraken.request({
          id: crypto.randomUUID(),
          method: 'repositoryLinkOpen',
          linkId,
        }),
      proposal.link.id,
    );
    expect(state).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('no longer available'),
    });
    await deliver(link(other));
    await deliver('openkraken://repo?path=%2Ftmp%2F..%2Fprivate');
    await deliver('openkraken://login?token=secret');
    // A subsequent valid link requires fresh consent; invalid links cannot replace it.
    await page.getByRole('button', { name: 'Review repository link', exact: true }).click();
    await expect(dialog).toContainText(other);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await deliver('openkraken://repo?path=%2Ftmp%2F..%2Fprivate');
    await deliver('openkraken://login?token=secret');
    await expect(page.getByRole('button', { name: 'Review repository link' })).toHaveCount(0);
    await expect(page.getByTestId('head')).toHaveText('main');
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('open-url delivery survives renderer reload and unavailable targets fail without replay', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-link-event-'));
  const path = join(root, 'missing repository');
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await expect(
      page.getByRole('button', { name: 'Open a repository', exact: true }),
    ).toBeVisible();
    await app.evaluate(({ app }, uri) => {
      app.emit('open-url', { preventDefault() {} }, uri);
    }, link(path));
    await expect(page.getByRole('button', { name: 'Review repository link' })).toBeVisible();
    await page.reload();
    await page.getByRole('button', { name: 'Review repository link', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Open linked repository', exact: true });
    await expect(dialog).toContainText(path);
    await dialog.getByRole('button', { name: 'Open repository', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByTestId('head')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Review repository link' })).toHaveCount(0);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
