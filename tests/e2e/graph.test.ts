import { pressShortcut } from '../electron-shortcut.js';
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createFixture, fixtureGit, fixtureKinds } from '../../packages/test-fixtures/src/index.js';
import type { FixtureKind } from '../../packages/test-fixtures/src/index.js';
async function launch(kind: FixtureKind = 'merge', count?: number) {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-graph-e2e-'));
  const repository = createFixture(join(root, 'repo'), kind, count);
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  const page = await app.firstWindow();
  await page.getByRole('button', { name: 'Open a repository', exact: true }).waitFor();
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, repository);
  await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
  await expect(page.getByTestId('commit-graph')).toBeVisible();
  return {
    root,
    repository,
    app,
    page,
    close: async () => {
      await app.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
test('Canvas search dims without moving rows; keyboard, ancestry, multi-select and details', async () => {
  const { app, page, close } = await launch();
  try {
    const grid = page.getByRole('grid');
    await grid.focus();
    const before = await grid.getByRole('row').evaluateAll((rows) =>
      rows.map((row) => ({
        oid: row.getAttribute('data-oid'),
        column: row.getAttribute('data-column'),
        y: (row as HTMLElement).style.transform,
      })),
    );
    const pixels = await page.getByTestId('commit-graph').evaluate((element: HTMLCanvasElement) => {
      const ctx = element.getContext('2d')!;
      return [...ctx.getImageData(0, 0, element.width, element.height).data]
        .filter((_, index) => index % 4 === 3)
        .filter((alpha) => alpha > 0).length;
    });
    expect(pixels).toBeGreaterThan(40);
    await grid.press('ArrowDown');
    await expect(grid.getByRole('row', { selected: true })).toHaveCount(1);
    const focused = await grid.getAttribute('aria-activedescendant');
    expect(focused).toBe('commit-row-1');
    await grid.press('Home');
    await grid.press('Shift+ArrowDown');
    await expect(grid.getByRole('row', { selected: true })).toContainText('Commit 2 — merge');
    await grid.press('Shift+ArrowUp');
    await expect(grid.getByRole('row', { selected: true })).toContainText('Commit 4 — merge');
    await grid.press('Shift+H');
    await expect(grid.getByRole('row', { selected: true })).toContainText('Commit 2 — merge');
    await grid.press('h');
    await expect(grid.getByRole('row', { selected: true })).toContainText('Commit 4 — merge');
    await grid
      .getByRole('row')
      .nth(2)
      .click({ modifiers: ['Shift'] });
    await expect(grid.getByRole('row', { selected: true })).toHaveCount(3);
    await grid
      .getByRole('row')
      .nth(1)
      .click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] });
    await expect(grid.getByRole('row', { selected: true })).toHaveCount(2);
    await grid.press('Enter');
    await expect(page.getByRole('region', { name: 'Commit details' })).toBeVisible();
    await page.getByRole('button', { name: 'Close details' }).click();
    await grid.focus();
    await pressShortcut(app, process.platform === 'darwin' ? 'Meta+F' : 'Control+F');
    await expect(page.getByRole('textbox', { name: 'Search commits' })).toBeFocused();
    await page.getByRole('textbox', { name: 'Search commits' }).fill('Commit 2');
    await expect(page.getByText('1 loaded matches', { exact: true })).toBeVisible();
    await expect(grid.locator('.dimmed')).toHaveCount(3);
    expect(
      await grid.getByRole('row').evaluateAll((rows) =>
        rows.map((row) => ({
          oid: row.getAttribute('data-oid'),
          column: row.getAttribute('data-column'),
          y: (row as HTMLElement).style.transform,
        })),
      ),
    ).toEqual(before);
    await page.getByRole('textbox', { name: 'Search commits' }).press('Enter');
    await expect(grid.getByRole('row', { selected: true })).toContainText('Commit 2 — merge');
    await page.getByRole('textbox', { name: 'Search commits' }).fill('');
    await expect(grid.locator('.dimmed')).toHaveCount(0);
    await grid.focus();
    await grid.press('Escape');
    await expect(grid.getByRole('row', { selected: true })).toHaveCount(0);
    await page.screenshot({ path: 'test-results/graph-merge.png' });
  } finally {
    await close();
  }
});
test('5000-commit pages append without changing previous lanes; unloaded search and bounded scrolling', async ({
  browserName: _browserName,
}, testInfo) => {
  const { page, repository, close } = await launch('linear', 12000);
  try {
    const grid = page.getByRole('grid');
    const before = await grid
      .getByRole('row')
      .evaluateAll((rows) =>
        rows
          .slice(0, 10)
          .map((row) => `${row.getAttribute('data-oid')}:${row.getAttribute('data-column')}`),
      );
    await page.getByRole('button', { name: 'Load more commits' }).click();
    await expect(page.getByTestId('commit-count')).toHaveText('7,000 commits · more available');
    expect(
      await grid
        .getByRole('row')
        .evaluateAll((rows) =>
          rows
            .slice(0, 10)
            .map((row) => `${row.getAttribute('data-oid')}:${row.getAttribute('data-column')}`),
        ),
    ).toEqual(before);
    const duration = await page.evaluate(
      () => performance.getEntriesByName('history-page').at(-1)?.duration,
    );
    console.log(
      await page.evaluate(() =>
        performance
          .getEntriesByType('mark')
          .filter((entry) => entry.name.startsWith('history-page'))
          .map((entry) => ({ name: entry.name, time: entry.startTime })),
      ),
    );
    console.log(`5000-commit page including worker layout/UI update: ${duration?.toFixed(1)} ms`);
    await testInfo.attach('paging.json', {
      body: JSON.stringify({ durationMs: duration, budgetMs: 300 }),
      contentType: 'application/json',
    });
    expect(duration).toBeLessThan(300);
    await page.getByRole('textbox', { name: 'Search commits' }).fill('Commit 4200 —');
    await expect(page.getByText('0 loaded matches', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Search all history' }).click();
    await expect(page.getByRole('button', { name: /Commit 4200 — linear/ })).toBeVisible();
    await page.getByRole('button', { name: /Commit 4200 — linear/ }).click();
    await expect(page.getByRole('region', { name: 'Commit details' })).toContainText(
      'Commit 4200 — linear',
    );
    await page.getByRole('button', { name: 'Close details' }).click();
    await page.getByRole('textbox', { name: 'Search commits' }).fill('');
    await grid.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(page.getByTestId('commit-count')).toHaveText('12,000 commits');
    await grid.focus();
    await grid.press('End');
    await expect(grid.getByRole('row', { selected: true })).toContainText('Commit 1 — linear');
    expect(await grid.getByRole('row').count()).toBeLessThan(100);
    const frames = await grid.evaluate(async (element) => {
      const samples: number[] = [];
      let previous = performance.now();
      for (let i = 0; i < 60; i++) {
        element.scrollTop = 1000 + i * 350;
        await new Promise<void>((resolve) =>
          requestAnimationFrame((now) => {
            samples.push(now - previous);
            previous = now;
            resolve();
          }),
        );
      }
      return samples.slice(2).sort((a, b) => a - b);
    });
    const p95 = frames[Math.floor(frames.length * 0.95)]!;
    console.log(`12k-row scrolling frame p95: ${p95.toFixed(1)} ms`);
    await testInfo.attach('scroll.json', {
      body: JSON.stringify({ rows: 12000, p95FrameMs: p95 }),
      contentType: 'application/json',
    });
    expect(await grid.getByRole('row').count()).toBeLessThan(100);
    const canvas = await page
      .getByTestId('commit-graph')
      .evaluate((element: HTMLCanvasElement) => ({
        height: element.height,
        viewport: element.clientHeight,
        ratio: devicePixelRatio,
      }));
    expect(canvas.height).toBeLessThanOrEqual(canvas.viewport * canvas.ratio + 1);
    await page.screenshot({ path: 'test-results/graph-large.png' });
    fixtureGit(repository, ['commit', '--allow-empty', '-m', 'After paging']);
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.getByTestId('commit-count')).toHaveText('2,000 commits · more available');
    await expect(grid.getByRole('row').first()).toContainText('After paging');
  } finally {
    await close();
  }
});
for (const kind of fixtureKinds)
  test(`${kind} graph visual golden`, async () => {
    const { page, close } = await launch(kind);
    try {
      await page.addStyleTag({
        content:
          '.graph-viewport { flex: none; height: 420px; } .history-scroll { outline: none !important; }',
      });
      await expect(page.getByTestId('commit-graph')).toHaveCSS('height', '420px');
      await page.getByRole('grid').focus();
      await expect(page.getByTestId('commit-graph')).toHaveScreenshot(`${kind}.png`, {
        maxDiffPixelRatio: 0.005,
        scale: 'css',
      });
    } finally {
      await close();
    }
  });

test('sidebar hide, solo and pin change graph roots and survive refresh', async () => {
  const { page, repository, close } = await launch('orphan');
  try {
    const grid = page.getByRole('grid');
    const other = fixtureGit(repository, ['rev-parse', 'other']);
    const parent = fixtureGit(repository, ['rev-parse', 'other~1']);
    await expect(page.getByTestId('commit-count')).toHaveText('4 commits');
    await page.getByRole('button', { name: 'Hide refs/heads/other', exact: true }).click();
    await expect(page.getByTestId('commit-count')).toHaveText('2 commits');
    await expect(grid.locator(`[data-oid="${other}"]`)).toHaveCount(0);
    await page.getByRole('button', { name: 'Hide refs/heads/other', exact: true }).click();
    await expect(page.getByTestId('commit-count')).toHaveText('4 commits');
    await page.getByRole('button', { name: 'Solo refs/heads/main', exact: true }).click();
    await expect(page.getByTestId('commit-count')).toHaveText('2 commits');
    await page.getByRole('button', { name: 'Pin refs/heads/other', exact: true }).click();
    await expect(page.getByTestId('commit-count')).toHaveText('4 commits');
    await expect(grid.locator(`[data-oid="${other}"]`)).toHaveAttribute('data-column', '0');
    await expect(grid.locator(`[data-oid="${parent}"]`)).toHaveAttribute('data-column', '0');
    await grid.locator(`[data-oid="${other}"]`).click();
    await page.getByRole('textbox', { name: 'Search commits' }).fill(other);
    await expect(page.getByText('1 loaded matches', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Pin refs/heads/other', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(grid.locator(`[data-oid="${other}"]`)).toHaveAttribute('data-column', '0');
    await expect(grid.locator(`[data-oid="${other}"]`)).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('textbox', { name: 'Search commits' })).toHaveValue(other);
    await expect(page.getByText('1 loaded matches', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Reset graph view', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Pin refs/heads/other', exact: true }),
    ).toHaveAttribute('aria-pressed', 'false');
    await page.screenshot({ path: 'test-results/graph-views.png' });
  } finally {
    await close();
  }
});
