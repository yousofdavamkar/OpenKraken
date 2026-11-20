import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from '@playwright/test';
import { createFixture, fixtureGit } from '../packages/test-fixtures/src/index.ts';

export function createPackagedHistoryFixture(repository) {
  createFixture(repository, 'linear', 7003);
  const target = fixtureGit(repository, ['rev-parse', 'HEAD~1']);
  const refs = [
    ...Array.from({ length: 100 }, (_, i) => `refs/tags/fixture-${i}`),
    'refs/archive/range-check-first',
    'refs/heads/range-check-branch',
    'refs/tags/range-check-tag',
    'refs/zz/range-check-last',
  ];
  fixtureGit(
    repository,
    ['update-ref', '--stdin'],
    refs.map((ref) => `create ${ref} ${target}\n`).join(''),
  );
}

async function checkPackagedReferenceList(page) {
  const filter = page.getByRole('textbox', { name: 'Filter references' });
  await filter.fill('  RANGE-CHECK  ');
  const list = page.getByRole('list', { name: 'Reference list' });
  const expected = [
    'refs/heads/range-check-branch',
    'refs/tags/range-check-tag',
    'refs/archive/range-check-first',
    'refs/zz/range-check-last',
  ];
  for (const [index, name] of expected.entries()) {
    const item = list
      .getByRole('listitem')
      .filter({ has: page.locator(`[data-reference-name="${name}"]`) });
    await expect(item).toHaveAttribute('aria-posinset', String(index + 1));
    await expect(item).toHaveAttribute('aria-setsize', '4');
  }
  await expect(list.getByRole('heading', { name: 'Other refs', exact: true })).toHaveCount(1);
  await filter.fill('');
  console.log(
    'Packaged sidebar preserved filtered positions across disjoint reference namespaces.',
  );
}

export async function checkPackagedHistory(page, repository) {
  const grid = page.getByRole('grid', { name: 'Commit history' });
  const count = page.getByTestId('commit-count');
  const canvas = page.getByTestId('commit-graph');
  const search = page.getByRole('textbox', { name: 'Search commits' });
  const selected = grid.getByRole('row', { selected: true });
  const details = page.getByRole('region', { name: 'Commit details' });
  const firstIds = fixtureGit(repository, ['rev-list', '--max-count=10', 'HEAD']).split('\n');
  const tip = firstIds[0];
  const firstRows = () =>
    grid.getByRole('row').evaluateAll((rows) =>
      rows.slice(0, 10).map((row) => ({
        oid: row.dataset.oid,
        column: row.dataset.column,
        position: row.style.transform,
      })),
    );
  const root = fixtureGit(repository, ['rev-list', '--max-parents=0', 'HEAD']);
  await expect(count).toHaveText('2,000 commits · more available');
  await checkPackagedReferenceList(page);
  await expect(grid).toHaveAttribute('aria-rowcount', '-1');
  const tipRow = grid.locator(`[data-oid="${tip}"]`);
  await expect(tipRow).toBeInViewport();
  const before = await firstRows();
  expect(before.map((row) => row.oid)).toEqual(firstIds);
  await expect
    .poll(() =>
      canvas.evaluate((element) => {
        const context = element.getContext('2d');
        const { data } = context.getImageData(0, 0, element.width, element.height);
        return data.some((value, index) => index % 4 === 3 && value > 0);
      }),
    )
    .toBe(true);

  await search.fill(root);
  await expect(page.getByText('0 loaded matches', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Search all history' }).click();
  await page
    .getByLabel('All history results')
    .getByRole('button', { name: /Commit 1 — linear/ })
    .click();
  await expect(details).toContainText(root);
  await page.getByRole('button', { name: 'Close details' }).click();

  const more = page.getByRole('button', { name: 'Load more commits' });
  await more.click();
  await expect(count).toHaveText('7,000 commits · more available');
  await expect(tipRow).toBeInViewport();
  expect(await firstRows()).toEqual(before);
  await more.click();
  await expect(count).toHaveText('7,003 commits');
  await expect(grid).toHaveAttribute('aria-rowcount', '7003');
  expect(await firstRows()).toEqual(before);
  await expect(page.getByText('1 loaded matches', { exact: true })).toBeVisible();
  await search.press('Enter');
  await expect(selected).toHaveAttribute('data-oid', root);
  await expect(selected).toBeInViewport();
  expect(await grid.getByRole('row').count()).toBeLessThan(100);
  const previous = fixtureGit(repository, ['rev-list', '--reverse', 'HEAD']).split('\n')[1];
  await grid.press('ArrowUp');
  await expect(selected).toHaveAttribute('data-oid', previous);
  await grid.press('Enter');
  await expect(details).toContainText(previous);
  await page.getByRole('button', { name: 'Close details' }).click();
  await grid.press('Home');
  await expect(selected).toHaveAttribute('data-oid', tip);
  const pageRows = await grid.evaluate((element) => {
    const row = element.querySelector('[role=row]');
    return Math.max(1, Math.floor(element.clientHeight / row.getBoundingClientRect().height));
  });
  await grid.press('PageDown');
  await expect(selected).toHaveAttribute('aria-rowindex', String(pageRows + 1));
  await grid.press('PageUp');
  await expect(selected).toHaveAttribute('data-oid', tip);
  await grid.press('Enter');
  await expect(details).toContainText(tip);
  await page.getByRole('button', { name: 'Close details' }).click();
  console.log(
    'Packaged Canvas, two history appends, repository search and keyboard navigation passed.',
  );
}

export async function advanceCachedFixture(profile, repository) {
  const id = createHash('sha256')
    .update(await realpath(repository))
    .digest('hex');
  const cached = JSON.parse(await readFile(join(profile, 'history', id, 'prefix.json'), 'utf8'));
  expect(cached.commits).toHaveLength(2000);
  expect(cached.commits[0].oid).toBe(fixtureGit(repository, ['rev-parse', 'HEAD']));
  fixtureGit(repository, [
    'commit',
    '--allow-empty',
    '-m',
    'Commit made while another repository was open',
  ]);
  return fixtureGit(repository, ['rev-parse', 'HEAD']);
}

export async function checkReopenedHistory(page, repository, tip) {
  const grid = page.getByRole('grid', { name: 'Commit history' });
  const count = page.getByTestId('commit-count');
  await expect(count).toHaveText('2,000 commits · more available');
  await grid.press('Home');
  const selected = grid.getByRole('row', { selected: true });
  await expect(selected).toHaveAttribute('data-oid', tip);
  const more = page.getByRole('button', { name: 'Load more commits' });
  await more.click();
  await expect(count).toHaveText('7,000 commits · more available');
  await more.click();
  await expect(count).toHaveText('7,004 commits');
  await grid.press('End');
  await expect(selected).toHaveAttribute(
    'data-oid',
    fixtureGit(repository, ['rev-list', '--max-parents=0', 'HEAD']),
  );
  console.log('Packaged graph reopened a changed cached repository and paged to its root.');
}
