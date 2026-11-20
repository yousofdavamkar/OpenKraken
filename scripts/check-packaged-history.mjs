import { expect } from '@playwright/test';
import { fixtureGit } from '../packages/test-fixtures/src/index.ts';

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
  expect(await firstRows()).toEqual(before);
  await expect(page.getByText('1 loaded matches', { exact: true })).toBeVisible();
  await search.press('Enter');
  await expect(selected).toHaveAttribute('data-oid', root);
  await expect(selected).toBeInViewport();
  expect(await grid.getByRole('row').count()).toBeLessThan(100);
  await grid.press('Home');
  await expect(selected).toHaveAttribute('data-oid', tip);
  await grid.press('Enter');
  await expect(details).toContainText(tip);
  await page.getByRole('button', { name: 'Close details' }).click();
  console.log(
    'Packaged Canvas, two history appends, repository search and keyboard navigation passed.',
  );
}
