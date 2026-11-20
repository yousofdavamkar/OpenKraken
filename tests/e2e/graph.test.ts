import { pressShortcut } from '../electron-shortcut.js';
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createFixture, fixtureGit, fixtureKinds } from '../../packages/test-fixtures/src/index.js';
import type { FixtureKind } from '../../packages/test-fixtures/src/index.js';
async function launch(
  kind: FixtureKind = 'merge',
  count?: number,
  prepare?: (path: string) => void,
) {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-graph-e2e-'));
  const repository = createFixture(join(root, 'repo'), kind, count);
  prepare?.(repository);
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
test('deep keyboard focus and range selection follow commit IDs when working rows shift', async () => {
  const { page, repository, close } = await launch('linear', 2200);
  try {
    await page.getByLabel('Refresh on focus', { exact: true }).uncheck();
    await expect(page.getByText('Watching for changes', { exact: true })).toBeVisible();
    const grid = page.getByRole('grid', { name: 'Commit history' });
    await page.getByRole('button', { name: 'Load more commits', exact: true }).click();
    await expect(grid).toHaveAttribute('aria-rowcount', '2200');
    const [root, second, third] = fixtureGit(repository, ['rev-list', '--reverse', 'HEAD']).split(
      '\n',
    );
    const selected = grid.getByRole('row', { selected: true });
    await grid.press('End');
    await expect(selected).toHaveAttribute('data-oid', root!);
    const draft = join(repository, 'untracked.txt');
    writeFileSync(draft, 'local change');
    await expect(grid).toHaveAttribute('aria-rowcount', '2201');
    await expect(selected).toHaveAttribute('aria-rowindex', '2201');
    await grid.press('Enter');
    const details = page.getByRole('region', { name: 'Commit details' });
    await expect(details).toContainText(root!);
    await page.getByRole('button', { name: 'Close details' }).click();
    await grid.press('ArrowUp');
    await expect(selected).toHaveAttribute('data-oid', second!);
    rmSync(draft);
    await expect(grid).toHaveAttribute('aria-rowcount', '2200');
    await expect(selected).toHaveAttribute('aria-rowindex', '2199');
    await grid.locator(`[data-oid="${third}"]`).click({ modifiers: ['Shift'] });
    await expect(selected).toHaveCount(2);
    await expect(grid.locator(`[data-oid="${second}"]`)).toHaveAttribute('aria-selected', 'true');
    await expect(grid.locator(`[data-oid="${third}"]`)).toHaveAttribute('aria-selected', 'true');
  } finally {
    await close();
  }
});

test('choosing the same search result reveals its virtualized row again', async () => {
  const { page, repository, close } = await launch('linear', 501);
  try {
    const oid = fixtureGit(repository, ['rev-parse', 'HEAD']);
    const grid = page.getByRole('grid', { name: 'Commit history' });
    const search = page.getByRole('textbox', { name: 'Search commits' });
    await search.fill(oid);
    await expect(page.getByText('1 loaded matches', { exact: true })).toBeVisible();
    const selected = grid.getByRole('row', { selected: true });
    await search.press('Enter');
    await expect(selected).toHaveAttribute('data-oid', oid);
    const scrollAway = async () => {
      await grid.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await expect(grid).not.toHaveAttribute('aria-activedescendant', /.+/);
    };
    await scrollAway();
    await search.press('Enter');
    await expect(selected).toBeInViewport();
    await expect(grid).toHaveAttribute('aria-activedescendant', 'commit-row-0');
    await page.getByRole('button', { name: 'Search all history' }).click();
    const result = page.locator('.search-results').getByRole('button').first();
    await expect(result).toContainText(oid.slice(0, 8));
    await scrollAway();
    await result.click();
    await expect(selected).toBeInViewport();
    await expect(grid).toHaveAttribute('aria-activedescendant', 'commit-row-0');
  } finally {
    await close();
  }
});

test('searching a hexadecimal branch name opens the commit with the matching object ID', async () => {
  const { page, repository, close } = await launch('linear', 12, (path) => {
    const prefix = fixtureGit(path, ['rev-parse', 'HEAD~6']).slice(0, 10);
    fixtureGit(path, ['branch', prefix, 'HEAD']);
  });
  try {
    const oid = fixtureGit(repository, ['rev-parse', 'HEAD~6']);
    await page.getByRole('textbox', { name: 'Search commits' }).fill(oid.slice(0, 10));
    await page.getByRole('button', { name: 'Search all history' }).click();
    const results = page.getByLabel('All history results');
    await expect(results.getByRole('button')).toHaveCount(1);
    await results.getByRole('button', { name: /Commit 6 — linear/ }).click();
    await expect(page.getByRole('region', { name: 'Commit details' })).toContainText(oid);
  } finally {
    await close();
  }
});
test('all-history stash search opens the stash by prefix and preserves literal message matches', async () => {
  const { page, repository, close } = await launch('stash', undefined, (path) => {
    const stash = fixtureGit(path, ['rev-parse', 'refs/stash']);
    fixtureGit(path, ['commit', '--allow-empty', '-m', `Investigate ${stash.slice(8, 20)}`]);
  });
  try {
    const stash = fixtureGit(repository, ['rev-parse', 'refs/stash']);
    const query = page.getByRole('textbox', { name: 'Search commits' });
    const search = page.getByRole('button', { name: 'Search all history' });
    const results = page.getByLabel('All history results').getByRole('button');
    await query.fill(stash.slice(8, 20));
    await search.click();
    await expect(results).toHaveCount(1);
    await expect(results).toContainText('Investigate');
    await query.fill(stash.slice(0, 12).toUpperCase());
    await search.click();
    await expect(results).toHaveCount(1);
    await expect(results).toContainText('Fixture stash');
    await results.click();
    await expect(page.getByRole('region', { name: 'Commit details' })).toContainText(stash);
  } finally {
    await close();
  }
});

test('cancelling the folder picker keeps an in-flight append and the next native page usable', async () => {
  const { app, page, close } = await launch('linear', 7200);
  try {
    await page.getByLabel('Refresh on focus', { exact: true }).uncheck();
    await expect(page.getByText('Watching for changes', { exact: true })).toBeVisible();
    const picker = await app.evaluateHandle(({ dialog }) => {
      let cancel!: () => void;
      const cancelled = new Promise<void>((resolve) => {
        cancel = resolve;
      });
      dialog.showOpenDialog = async () => {
        await cancelled;
        return { canceled: true, filePaths: [] };
      };
      return { cancel };
    });
    await page.evaluate(() => {
      const send = Worker.prototype.postMessage;
      Worker.prototype.postMessage = new Proxy(send, {
        apply(target, worker, args) {
          if (args[0].method !== 'append') return Reflect.apply(target, worker, args);
          Worker.prototype.postMessage = send;
          window.addEventListener(
            'test-release-append',
            () => Reflect.apply(target, worker, args),
            { once: true },
          );
          performance.mark('test-append-pending');
        },
      });
    });
    const more = page.getByRole('button', { name: 'Load more commits', exact: true });
    await more.click();
    await page.waitForFunction(() => performance.getEntriesByName('test-append-pending').length);
    const open = page.getByRole('button', { name: 'Open repository', exact: true });
    await open.click();
    await expect(open).toBeDisabled();
    await page.evaluate(() => window.dispatchEvent(new Event('test-release-append')));
    await expect(page.getByTestId('commit-count')).toHaveText('7,000 commits · more available');
    await picker.evaluate(({ cancel }) => cancel());
    await expect(open).toBeEnabled();
    await more.click();
    await expect(page.getByTestId('commit-count')).toHaveText('7,200 commits');
    await page.getByRole('grid').press('End');
    await expect(page.getByRole('row', { selected: true })).toContainText('Commit 1 — linear');
  } finally {
    await close();
  }
});

test('external staging preserves an active search without resending the loaded graph', async () => {
  const { page, repository, close } = await launch('linear', 7200, (path) => {
    writeFileSync(join(path, 'stage-me.txt'), 'new file\n');
  });
  try {
    await page.getByLabel('Refresh on focus', { exact: true }).uncheck();
    await expect(page.getByText('Watching for changes', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Load more commits', exact: true }).click();
    await expect(page.getByTestId('commit-count')).toHaveText('7,000 commits · more available');
    await page.getByRole('textbox', { name: 'Search commits' }).fill('stage-me');
    const matches = page.getByText('1 loaded matches', { exact: true });
    await expect(matches).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Stage stage-me.txt', exact: true }),
    ).toBeVisible();
    await page.evaluate(() => {
      Worker.prototype.postMessage = new Proxy(Worker.prototype.postMessage, {
        apply(send, worker, args) {
          const [message] = args;
          if (message.method === 'refresh' || message.method === 'reset')
            performance.mark('test-graph-reload', { detail: message.commits.length });
          if (message.method === 'updateSearchDocument')
            performance.mark('test-graph-document', { detail: message.document.body });
          return Reflect.apply(send, worker, args);
        },
      });
    });
    fixtureGit(repository, ['add', '--', 'stage-me.txt']);
    await expect(
      page.getByRole('button', { name: 'Unstage stage-me.txt', exact: true }),
    ).toBeEnabled();
    await expect(matches).toBeVisible();
    await expect(page.getByTestId('commit-count')).toHaveText('7,000 commits · more available');
    fixtureGit(repository, ['mv', 'stage-me.txt', 'replacement.txt']);
    await expect(page.getByText('0 loaded matches', { exact: true })).toBeVisible();
    await page.getByRole('textbox', { name: 'Search commits' }).fill('replacement');
    await expect(matches).toBeVisible();
    expect(
      await page.evaluate(() =>
        performance
          .getEntriesByName('test-graph-document')
          .some((entry) => (entry as PerformanceMark).detail.includes('replacement.txt')),
      ),
    ).toBe(true);
    expect(
      await page.evaluate(() =>
        performance
          .getEntriesByName('test-graph-reload')
          .map((entry) => (entry as PerformanceMark).detail),
      ),
    ).toEqual([]);
  } finally {
    await close();
  }
});
test('Refresh recovers a terminated graph worker and resumes search and paging', async () => {
  const { page, repository, close } = await launch('linear', 2200);
  try {
    const grid = page.getByRole('grid');
    await grid.press('ArrowDown');
    const selected = await grid.getByRole('row', { selected: true }).getAttribute('data-oid');
    await page.evaluate(() => {
      const original = Worker.prototype.postMessage;
      Worker.prototype.postMessage = new Proxy(original, {
        apply(send, worker: Worker, args) {
          if (args[0].method !== 'search') return Reflect.apply(send, worker, args);
          Worker.prototype.postMessage = original;
          worker.terminate();
          worker.dispatchEvent(new ErrorEvent('error', { message: 'Graph stopped during search' }));
        },
      });
    });
    await page.getByRole('textbox', { name: 'Search commits' }).fill('Commit 2199');
    await expect(page.getByText(/Graph stopped during search/)).toBeVisible();
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.getByText('1 loaded matches', { exact: true })).toBeVisible();
    await expect(grid.getByRole('row', { selected: true })).toHaveAttribute('data-oid', selected!);
    await page.getByRole('button', { name: 'Load more commits' }).click();
    await expect(page.getByTestId('commit-count')).toHaveText('2,200 commits');
    await page
      .getByRole('textbox', { name: 'Search commits' })
      .fill(fixtureGit(repository, ['rev-parse', 'HEAD~2100']).slice(0, 12));
    await expect(page.getByText('1 loaded matches', { exact: true })).toBeVisible();
  } finally {
    await close();
  }
});
test('Refresh recovers after a completed worker refresh loses its reply', async () => {
  const { page, close } = await launch('linear', 2200);
  try {
    const count = page.getByTestId('commit-count');
    const refresh = page.getByRole('button', { name: 'Refresh', exact: true });
    const query = page.getByRole('textbox', { name: 'Search commits' });
    await page.getByLabel('Refresh on focus', { exact: true }).uncheck();
    await expect(page.getByText('Watching for changes', { exact: true })).toBeVisible();
    await query.fill('Commit 2199');
    await expect(page.getByText('1 loaded matches', { exact: true })).toBeVisible();
    await page.clock.install();
    await page.evaluate(() => {
      const send = Worker.prototype.postMessage;
      Worker.prototype.postMessage = new Proxy(send, {
        apply(target, worker: Worker, args) {
          if (args[0].method === 'refresh') {
            Worker.prototype.postMessage = send;
            const receive = worker.onmessage;
            worker.onmessage = (event) => {
              if (event.data.id !== args[0].id) return receive?.call(worker, event);
              worker.onmessage = receive;
              document.documentElement.dataset.droppedGraphReply = 'true';
            };
          }
          return Reflect.apply(target, worker, args);
        },
      });
    });
    await refresh.click();
    await expect(page.locator('html')).toHaveAttribute('data-dropped-graph-reply', 'true');
    await page.clock.fastForward(30001);
    await expect(page.getByText('Graph worker timed out', { exact: false })).toBeVisible();
    await refresh.click();
    await expect(refresh).toBeEnabled();
    await page.getByRole('button', { name: 'Load more commits' }).click();
    await expect(count).toHaveText('2,200 commits');
    await expect(page.getByText('1 loaded matches', { exact: true })).toBeVisible();
  } finally {
    await close();
  }
});
test('a refresh that fails during dispatch cannot later close the recovered worker', async () => {
  const { page, repository, close } = await launch('linear', 2200);
  try {
    const refresh = page.getByRole('button', { name: 'Refresh', exact: true });
    const query = page.getByRole('textbox', { name: 'Search commits' });
    await page.getByLabel('Refresh on focus', { exact: true }).uncheck();
    await expect(page.getByText('Watching for changes', { exact: true })).toBeVisible();
    await query.fill('Commit 2199');
    await expect(page.getByText('1 loaded matches', { exact: true })).toBeVisible();
    await page.clock.install();
    await page.evaluate(() => {
      const send = Worker.prototype.postMessage;
      Worker.prototype.postMessage = new Proxy(send, {
        apply(target, worker, args) {
          if (args[0].method !== 'refresh') return Reflect.apply(target, worker, args);
          Worker.prototype.postMessage = send;
          throw new DOMException('Could not clone the refresh', 'DataCloneError');
        },
      });
    });
    await refresh.click();
    await expect(page.getByText('Could not clone the refresh', { exact: false })).toBeVisible();
    await refresh.click();
    await expect(refresh).toBeEnabled();
    await expect(page.getByText('Could not clone the refresh', { exact: false })).toHaveCount(0);
    await page.clock.fastForward(30001);
    await page.getByRole('button', { name: 'Load more commits' }).click();
    await expect(page.getByTestId('commit-count')).toHaveText('2,200 commits');
    await query.fill(fixtureGit(repository, ['rev-parse', 'HEAD~2100']).slice(0, 12));
    await expect(page.getByText('1 loaded matches', { exact: true })).toBeVisible();
  } finally {
    await close();
  }
});
test('an incomplete append layout keeps the displayed page and refresh recovers search and paging', async () => {
  const { page, repository, close } = await launch('linear', 2200);
  try {
    const count = page.getByTestId('commit-count');
    const more = page.getByRole('button', { name: 'Load more commits' });
    const query = page.getByRole('textbox', { name: 'Search commits' });
    await page.getByLabel('Refresh on focus', { exact: true }).uncheck();
    await expect(page.getByText('Watching for changes', { exact: true })).toBeVisible();
    await page.evaluate(() => {
      const send = Worker.prototype.postMessage;
      Worker.prototype.postMessage = new Proxy(send, {
        apply(target, worker: Worker, args) {
          if (args[0].method === 'append') {
            Worker.prototype.postMessage = send;
            const receive = worker.onmessage;
            worker.onmessage = (event) => {
              if (event.data.id === args[0].id && event.data.kind === 'packed-layout') {
                worker.onmessage = receive;
                // Drop the last complete row and its edges. The remaining records still decode.
                event.data.nodes = event.data.nodes.subarray(0, -4);
                event.data.edges = event.data.edges.subarray(0, event.data.nodes.at(-1) ?? 0);
              }
              return receive?.call(worker, event);
            };
          }
          return Reflect.apply(target, worker, args);
        },
      });
    });
    await more.click();
    await expect(page.getByText(/Incomplete graph layout/)).toBeVisible();
    await expect(count).toHaveText('2,000 commits · more available');
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await more.click();
    await expect(count).toHaveText('2,200 commits');
    await query.fill(fixtureGit(repository, ['rev-parse', 'HEAD~2100']).slice(0, 12));
    await expect(page.getByText('1 loaded matches', { exact: true })).toBeVisible();
  } finally {
    await close();
  }
});

test('a side lane stays painted across an append that splits a 500-row bucket', async () => {
  const { page, close } = await launch('linear', 2200, (repo) => {
    const ancestor = fixtureGit(repo, ['rev-parse', 'HEAD~2150']);
    const merge = fixtureGit(repo, [
      'commit-tree',
      'HEAD^{tree}',
      '-p',
      'HEAD',
      '-p',
      ancestor,
      '-m',
      'Long side lane',
    ]);
    fixtureGit(repo, ['update-ref', 'refs/heads/main', merge]);
    // The working-tree row shifts the first 2,000-commit boundary to graph row 2,001.
    writeFileSync(join(repo, 'dirty.txt'), 'working change');
  });
  try {
    const grid = page.getByRole('grid', { name: 'Commit history' });
    const canvas = page.getByTestId('commit-graph');
    const paintedLanes = async (row: number) => {
      await grid.evaluate((element, index) => {
        element.scrollTop = (index - 3) * 28;
      }, row);
      await expect(grid.locator(`[aria-rowindex="${row + 1}"]`)).toBeInViewport();
      return canvas.evaluate(async (element, index) => {
        await new Promise<void>((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done())),
        );
        const context = (element as HTMLCanvasElement).getContext('2d')!;
        const top = document.getElementById('commit-history')!.scrollTop;
        const y = Math.floor((index * 28 + 14 - top) * devicePixelRatio);
        return [14, 34].map((x) => {
          const pixel = context.getImageData(Math.floor(x * devicePixelRatio), y, 1, 1);
          return pixel.data[3]! > 0;
        });
      }, row);
    };
    expect(await paintedLanes(503)).toEqual([true, true]);
    await page.getByRole('button', { name: 'Load more commits', exact: true }).click();
    await expect(page.getByTestId('commit-count')).toHaveText('2,201 commits');
    expect(await paintedLanes(503)).toEqual([true, true]);
    expect(await paintedLanes(2000)).toEqual([true, true]);
    expect(await paintedLanes(2001)).toEqual([true, true]);
    // The first-parent chain joins the reserved second lane at the ancestor.
    expect(await paintedLanes(2170)).toEqual([false, true]);
  } finally {
    await close();
  }
});

test('one Down key moves past the last initially loaded commit', async () => {
  const { page, close } = await launch('linear', 2003);
  try {
    const grid = page.getByRole('grid');
    await expect(grid).toHaveAttribute('aria-rowcount', '-1');
    await expect(grid).toHaveAccessibleDescription('2,000 commits · more available');
    // Stay at the top while End selects the last loaded row. Scrolling there would prefetch it.
    await grid.evaluate((element) => {
      Object.defineProperty(element, 'scrollTo', { configurable: true, value: () => {} });
    });
    await grid.focus();
    await grid.press('End');
    await expect(grid).not.toHaveAttribute('aria-activedescendant', /.+/);
    await expect(page.getByTestId('commit-count')).toHaveText('2,000 commits · more available');
    await grid.evaluate((element) => Reflect.deleteProperty(element, 'scrollTo'));
    await grid.press('ArrowDown');
    await expect(grid.getByRole('row', { selected: true })).toContainText('Commit 3 — linear');
    await expect(grid).toHaveAttribute('aria-rowcount', '2003');
    await expect(grid.getByRole('row', { selected: true })).toHaveAttribute(
      'aria-rowindex',
      '2001',
    );
    await expect(grid).toHaveAccessibleDescription('2,003 commits');
  } finally {
    await close();
  }
});
test('the upstream shortcut follows three native pages to the root commit', async () => {
  const { page, repository, close } = await launch('linear', 12003, (repo) => {
    const root = fixtureGit(repo, ['rev-list', '--max-parents=0', 'HEAD']);
    fixtureGit(repo, ['branch', 'old-tip', root]);
    fixtureGit(repo, ['branch', '--set-upstream-to=old-tip', 'main']);
  });
  try {
    const grid = page.getByRole('grid', { name: 'Commit history' });
    await expect(page.getByTestId('commit-count')).toHaveText('2,000 commits · more available');
    await grid.press('Shift+H');
    const selected = grid.getByRole('row', { selected: true });
    await expect(selected).toHaveAttribute(
      'data-oid',
      fixtureGit(repository, ['rev-parse', 'old-tip']),
    );
    await expect(selected).toBeInViewport();
    await expect(page.getByTestId('commit-count')).toHaveText('12,003 commits');
    await grid.press('Enter');
    await expect(page.getByRole('region', { name: 'Commit details' })).toContainText(
      'Commit 1 — linear',
    );
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
    await grid.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(page.getByTestId('commit-count')).toHaveText('12,000 commits');
    await expect(page.getByText('1 loaded matches', { exact: true })).toBeVisible();
    await expect(
      page.locator('.search-results').getByRole('button', { name: /Commit 4200 — linear/ }),
    ).toBeVisible();
    await page.getByRole('textbox', { name: 'Search commits' }).fill('');
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
    // The scroll sample moved the viewport away from the selected last commit.
    await expect(grid).not.toHaveAttribute('aria-activedescendant', /.+/);
    await grid.press('End');
    await expect(grid).toHaveAttribute('aria-activedescendant', 'commit-row-11999');
    await expect(grid.getByRole('row', { selected: true })).toBeInViewport();
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

test('nested release tags label and select history reachable only through the tag chain', async () => {
  let oid = '';
  const { page, close } = await launch('linear', 4, (path) => {
    const tree = fixtureGit(path, ['rev-parse', 'HEAD^{tree}']);
    oid = fixtureGit(path, ['commit-tree', tree, '-m', 'Archived release notes']);
    fixtureGit(path, ['tag', '-a', 'inner', '-m', 'Inner', oid]);
    fixtureGit(path, [
      '-c',
      'advice.nestedTag=false',
      'tag',
      '-a',
      'release',
      '-m',
      'Release',
      'inner',
    ]);
    fixtureGit(path, ['tag', '-d', 'inner']);
  });
  try {
    const grid = page.getByRole('grid', { name: 'Commit history' });
    const row = grid.locator(`[data-oid="${oid}"]`);
    await expect(row).toContainText('Archived release notes');
    await expect(row).toContainText('release');
    await page.getByRole('button', { name: 'Solo refs/tags/release', exact: true }).click();
    await expect(grid.getByRole('row')).toHaveCount(1);
    await grid.press('Home');
    await expect(row).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('textbox', { name: 'Search commits' }).fill(oid);
    await page.getByRole('button', { name: 'Search all history' }).click();
    await expect(page.getByLabel('All history results')).toContainText('Archived release notes');
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

test('commit search keeps IME composition and held keys from changing the graph selection', async () => {
  const { page, close } = await launch('linear', 4, (repo) => {
    fixtureGit(repo, ['commit', '--allow-empty', '-m', '検索対象']);
    fixtureGit(repo, ['commit', '--allow-empty', '-m', 'Newest change']);
  });
  try {
    const search = page.getByRole('textbox', { name: 'Search commits' });
    const grid = page.getByRole('grid', { name: 'Commit history' });
    const selected = grid.getByRole('row', { selected: true });
    await search.fill('検索');
    await expect(page.getByText('1 loaded matches', { exact: true })).toBeVisible();
    for (const key of ['Enter', 'Escape']) {
      await search.dispatchEvent('keydown', { key, isComposing: true });
      await expect(search).toBeFocused();
      await expect(search).toHaveValue('検索');
      await expect(selected).toContainText('Newest change');
    }
    await search.dispatchEvent('keydown', { key: 'Enter', repeat: true });
    await expect(search).toBeFocused();
    await search.press('Enter');
    await expect(grid).toBeFocused();
    await expect(selected).toContainText('検索対象');
    await grid.dispatchEvent('keydown', { key: 'Enter', repeat: true });
    await expect(page.getByRole('region', { name: 'Commit details' })).toHaveCount(0);
    await search.focus();
    await search.press('Escape');
    await expect(search).toHaveValue('');
    await expect(grid).toBeFocused();
    await grid.dispatchEvent('keydown', { key: 'Escape', repeat: true });
    await expect(selected).toContainText('検索対象');
    await grid.press('Escape');
    await expect(selected).toHaveCount(0);
  } finally {
    await close();
  }
});
