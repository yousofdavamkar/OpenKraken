import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createFixture, fixtureGit } from '../../packages/test-fixtures/src/index.js';

test('large reference sidebar stays bounded and filtered actions survive scrolling', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-many-refs-'));
  const repository = createFixture(join(root, 'repo'), 'linear', 2200);
  const commits = fixtureGit(repository, ['rev-list', '--max-count=1000', 'HEAD']).split('\n');
  fixtureGit(
    repository,
    ['update-ref', '--stdin'],
    commits
      .map((oid, index) => `create refs/heads/topic-${String(index).padStart(4, '0')} ${oid}`)
      .join('\n') + '\n',
  );
  fixtureGit(repository, ['branch', 'Ångström']);
  const mixed = [
    'refs/heads/zz-group-edge',
    'refs/remotes/upstream/group-edge',
    ...Array.from({ length: 5 }, (_, index) => 'refs/tags/group-edge-' + index),
  ];
  fixtureGit(
    repository,
    ['update-ref', '--stdin'],
    mixed.map((name) => `create ${name} ${commits[0]}`).join('\n') + '\n',
  );
  const refCount = fixtureGit(repository, ['for-each-ref', '--format=.']).split('\n').length;
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, repository);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    await expect(page.getByTestId('commit-count')).toContainText('2,000 commits');
    const sidebar = page.locator('.refs');
    expect(await sidebar.locator('.ref').count()).toBeLessThan(80);
    const firstItem = sidebar.getByRole('listitem').first();
    const firstRef = firstItem.locator('.ref');
    // A row can grow independently of other branches (for example, to display an error).
    for (const minHeight of ['250px', '']) {
      await firstRef.evaluate((element, height) => {
        element.style.minHeight = height;
      }, minHeight);
      await expect
        .poll(() =>
          firstItem.evaluate((item) =>
            Math.abs(
              item.nextElementSibling!.getBoundingClientRect().top -
                item.getBoundingClientRect().bottom,
            ),
          ),
        )
        .toBeLessThan(1);
    }
    const filter = sidebar.getByRole('textbox', { name: 'Filter references', exact: true });
    await expect(sidebar.getByRole('status')).toHaveText(
      `${refCount.toLocaleString()} matching references`,
    );
    const edge = sidebar.locator('[data-reference-name="refs/heads/topic-0006"]');
    const next = sidebar.locator('[data-reference-name="refs/heads/topic-0007"]');
    await edge.scrollIntoViewIfNeeded();
    for (const minHeight of ['260px', '']) {
      await edge.evaluate((element, height) => {
        element.style.minHeight = height;
      }, minHeight);
      await expect
        .poll(async () => {
          const bottom = await edge.evaluate((element) => element.getBoundingClientRect().bottom);
          const top = await next.evaluate((element) => element.getBoundingClientRect().top);
          return Math.abs(top - bottom);
        })
        .toBeLessThan(1);
    }
    await edge.getByRole('button', { name: 'Rename branch topic-0006' }).click();
    const pendingRename = page.getByRole('dialog', { name: 'Rename branch', exact: true });
    const draft = pendingRename.getByRole('textbox', { name: 'Branch name' });
    await draft.fill('pending-name');
    fixtureGit(repository, ['branch', 'a-before-main']);
    await expect(sidebar.locator('.reference-match-count')).toHaveText(
      `${(refCount + 1).toLocaleString()} matching references`,
    );
    await expect(draft).toBeFocused();
    await expect(draft).toHaveValue('pending-name');
    await pendingRename.getByRole('button', { name: 'Cancel', exact: true }).click();
    fixtureGit(repository, ['branch', '-D', 'a-before-main']);
    await expect(sidebar.getByRole('status')).toHaveText(
      `${refCount.toLocaleString()} matching references`,
    );
    await filter.fill('group-edge');
    await expect(sidebar.getByRole('status')).toHaveText('7 matching references');
    const refList = sidebar.getByRole('list', { name: 'Reference list' });
    // The tag section starts after two one-row sections and ends in a partial block.
    await refList.evaluate((list) => list.scrollTo(0, list.scrollHeight));
    const lastTag = sidebar
      .getByRole('listitem')
      .filter({ has: page.locator('[data-reference-name="refs/tags/group-edge-4"]') });
    await expect(lastTag).toHaveAttribute('aria-posinset', '7');
    await expect(lastTag).toHaveAttribute('aria-setsize', '7');
    await refList.evaluate((list) => list.scrollTo(0, 0));
    await expect(sidebar.getByRole('heading', { name: 'Branches', exact: true })).toBeVisible();
    await expect(sidebar.getByRole('listitem').first()).toHaveAttribute('aria-posinset', '1');
    await filter.fill('  ÅNGSTRÖM  ');
    await expect(
      sidebar.getByRole('button', { name: 'Rename branch Ångström', exact: true }),
    ).toBeVisible();
    await expect(sidebar.locator('.ref')).toHaveCount(1);
    await expect(sidebar.getByRole('listitem')).toHaveAttribute('aria-posinset', '1');
    await expect(sidebar.getByRole('listitem')).toHaveAttribute('aria-setsize', '1');
    await filter.fill('   ');
    await expect(sidebar.getByRole('status')).toHaveText(
      `${refCount.toLocaleString()} matching references`,
    );
    await filter.fill('TOPIC-0998');
    await expect(
      sidebar.getByRole('button', { name: 'Rename branch topic-0998', exact: true }),
    ).toBeVisible();
    await filter.fill('TOPIC-0999');
    const rename = sidebar.getByRole('button', { name: 'Rename branch topic-0999', exact: true });
    await expect(rename).toBeVisible();
    await expect(sidebar.locator('.ref')).toHaveCount(1);
    await rename.focus();
    await rename.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Rename branch', exact: true });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await filter.fill('');
    const scroll = sidebar.getByRole('list', { name: 'Reference list', exact: true });
    const mainAction = sidebar.getByRole('button', { name: 'Rename branch main', exact: true });
    await mainAction.focus();
    await scroll.focus();
    await expect(scroll).toBeFocused();
    await scroll.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(
      sidebar.getByRole('button', { name: 'Delete tag v0.1.0', exact: true }),
    ).toBeVisible();
    await expect(mainAction).toHaveCount(0);
    expect(await sidebar.locator('.ref').count()).toBeLessThan(80);
    await scroll.evaluate((element) => {
      element.scrollTop = 0;
    });
    await sidebar.getByRole('button', { name: 'Rename branch main', exact: true }).click();
    await expect(dialog).toBeVisible();
    await scroll.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('textbox', { name: 'Branch name', exact: true }).fill('main-renamed');
    await dialog.getByRole('button', { name: 'Rename branch', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('head')).toHaveText('main-renamed');
    expect(fixtureGit(repository, ['symbolic-ref', '--short', 'HEAD'])).toBe('main-renamed');
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a pending rename survives switching between grouped and virtualized references', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-ref-threshold-'));
  const repository = createFixture(join(root, 'repo'));
  const tip = fixtureGit(repository, ['rev-parse', 'HEAD']);
  const existing = fixtureGit(repository, ['for-each-ref', '--format=%(refname)']).split('\n');
  fixtureGit(
    repository,
    ['update-ref', '--stdin'],
    Array.from(
      { length: 99 - existing.length },
      (_, index) => `create refs/tags/fixture-${index} ${tip}\n`,
    ).join(''),
  );
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, repository);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    const rename = page.getByRole('button', { name: 'Rename branch main', exact: true });
    await rename.click();
    const dialog = page.getByRole('dialog', { name: 'Rename branch', exact: true });
    const draft = dialog.getByRole('textbox', { name: 'Branch name', exact: true });
    await draft.fill('keep-this-name');
    fixtureGit(repository, ['branch', 'threshold']);
    await expect(page.getByRole('heading', { name: 'References 100', exact: true })).toBeVisible();
    await expect(draft).toHaveValue('keep-this-name');
    await expect(draft).toBeFocused();
    fixtureGit(repository, ['branch', '-D', 'threshold']);
    await expect(page.getByRole('heading', { name: 'References 99', exact: true })).toBeVisible();
    await expect(draft).toBeFocused();
    await expect(draft).toHaveValue('keep-this-name');
    await dialog.getByRole('button', { name: 'Rename branch', exact: true }).click();
    await expect(page.getByTestId('head')).toHaveText('keep-this-name');
    expect(fixtureGit(repository, ['rev-parse', 'refs/heads/keep-this-name'])).toBe(tip);
    const renamed = page.getByRole('button', { name: 'Rename branch keep-this-name', exact: true });
    await renamed.click();
    fixtureGit(repository, ['branch', 'threshold']);
    await expect(page.getByRole('heading', { name: 'References 100', exact: true })).toBeVisible();
    await draft.press('Escape');
    await expect(renamed).toBeFocused();

    const threshold = page.getByRole('button', { name: 'Rename branch threshold', exact: true });
    await threshold.click();
    await draft.fill('removed-branch');
    fixtureGit(repository, ['branch', '-D', 'threshold']);
    await expect(dialog).toHaveCount(0);
    fixtureGit(repository, ['branch', 'threshold']);
    await expect(page.getByRole('heading', { name: 'References 100', exact: true })).toBeVisible();
    await expect(dialog).toHaveCount(0);

    await threshold.click();
    await draft.fill('obsolete-review');
    const parent = fixtureGit(repository, ['rev-parse', 'HEAD^']);
    fixtureGit(repository, ['update-ref', 'refs/heads/threshold', parent, tip]);
    await expect(page.locator('[data-reference-name="refs/heads/threshold"]')).toHaveAttribute(
      'title',
      'refs/heads/threshold\n' + parent,
    );
    await dialog.getByRole('button', { name: 'Rename branch', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('The branch changed');
    await expect(draft).toHaveValue('obsolete-review');
    expect(fixtureGit(repository, ['rev-parse', 'refs/heads/threshold'])).toBe(parent);
    expect(fixtureGit(repository, ['branch', '--list', 'obsolete-review'])).toBe('');
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
