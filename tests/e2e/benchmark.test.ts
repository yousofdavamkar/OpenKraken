import { _electron as electron, expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { cpus, release, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Opt-in, read-only benchmark against an existing repository. Never fetches or mutates it.
const repository = process.env.OPENKRAKEN_BENCH_REPO;
test('real-repository first paint, paging and scrolling budgets', async ({
  browserName: _browserName,
}, testInfo) => {
  test.skip(!repository, 'Set OPENKRAKEN_BENCH_REPO to a local full-history repository');
  test.setTimeout(120000);
  const path = resolve(repository!);
  const profile = mkdtempSync(join(tmpdir(), 'openkraken-bench-'));
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${profile}`],
  });
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Open a repository', exact: true }).waitFor();
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, path);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    await expect
      .poll(
        () => page.evaluate(() => performance.getEntriesByName('repository-first-paint').length),
        { timeout: 60000 },
      )
      .toBeGreaterThan(0);
    const firstPaintMs = await page.evaluate(
      () => performance.getEntriesByName('repository-first-paint').at(-1)!.duration,
    );
    const grid = page.getByRole('grid'),
      pages: number[] = [];
    for (const loaded of [7000, 12000]) {
      await page.getByRole('button', { name: 'Load more commits', exact: true }).click();
      await expect(page.getByTestId('commit-count')).toHaveText(
        `${loaded.toLocaleString('en-US')} commits · more available`,
      );
      pages.push(
        await page.evaluate(() => performance.getEntriesByName('history-page').at(-1)!.duration),
      );
    }
    const frames = await grid.evaluate(async (element) => {
      const samples: number[] = [];
      let previous = performance.now();
      for (let i = 0; i < 120; i++) {
        element.scrollTop = 500 + i * 1400;
        await new Promise<void>((done) =>
          requestAnimationFrame((now) => {
            samples.push(now - previous);
            previous = now;
            done();
          }),
        );
      }
      return samples.slice(2).sort((a, b) => a - b);
    });
    const p95FrameMs = frames[Math.floor(frames.length * 0.95)]!;
    const mountedRows = await grid.getByRole('row').count();
    await page.getByRole('button', { name: 'Load more commits', exact: true }).click();
    await expect(page.getByTestId('commit-count')).toHaveText('17,000 commits · more available');
    pages.push(
      await page.evaluate(() => performance.getEntriesByName('history-page').at(-1)!.duration),
    );
    const memory = await app.evaluate(({ app }) =>
      app.getAppMetrics().map((m) => ({
        type: m.type,
        workingSetKiB: m.memory.workingSetSize,
      })),
    );
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: path, encoding: 'utf8', timeout: 30000 }).trim();
    const measurement = {
      repository: path,
      head: git('rev-parse', 'HEAD'),
      commits: Number(git('rev-list', '--count', 'HEAD')),
      shallow: git('rev-parse', '--is-shallow-repository'),
      git: git('--version'),
      platform: `${process.platform} ${process.arch} ${release()}`,
      cpu: cpus()[0]?.model,
      firstPaintMs,
      page5000Ms: pages,
      scrollingRows: 12000,
      p95FrameMs,
      mountedRows,
      electronMemory: memory,
      cache: 'OS cache not cleared; includes startup of a fresh app process',
    };
    console.log(JSON.stringify(measurement, null, 2));
    await testInfo.attach('real-repository-benchmark.json', {
      body: JSON.stringify(measurement, null, 2),
      contentType: 'application/json',
    });
    await page.screenshot({ path: testInfo.outputPath('real-repository.png') });
    expect(mountedRows).toBeLessThan(100);
    expect.soft(firstPaintMs).toBeLessThan(500);
    for (const pageMs of pages) expect.soft(pageMs).toBeLessThan(300);
    // 60 Hz is ~16.67 ms; allow 2 ms scheduling jitter in the headless runner.
    expect.soft(p95FrameMs).toBeLessThan(18.7);
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});
