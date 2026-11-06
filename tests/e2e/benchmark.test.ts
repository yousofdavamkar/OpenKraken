import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { RepositoryPreferences } from '../../packages/git-core/src/preferences.js';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, release, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Opt-in benchmark: no Git writes. The observer creates/removes its private self-test probe.
const repository = process.env.OPENKRAKEN_BENCH_REPO;
const warm = process.env.OPENKRAKEN_BENCH_WARM === '1';
test('real-repository first paint, paging and scrolling budgets', async ({
  browserName: _browserName,
}, testInfo) => {
  test.skip(!repository, 'Set OPENKRAKEN_BENCH_REPO to a local full-history repository');
  test.setTimeout(120000);
  const path = resolve(repository!);
  const profile = mkdtempSync(join(tmpdir(), 'openkraken-bench-'));
  const args = [resolve('apps/desktop'), `--user-data-dir=${profile}`];
  let app: ElectronApplication | undefined;
  try {
    let hiddenTags: string[] = [];
    if (process.env.OPENKRAKEN_BENCH_HIDDEN_TAGS === '1') {
      hiddenTags = execFileSync(
        'git',
        ['for-each-ref', '--count=10000', '--format=%(refname)', 'refs/tags'],
        {
          cwd: path,
          encoding: 'utf8',
          maxBuffer: 16 * 1024 * 1024,
        },
      )
        .trimEnd()
        .split('\n');
      expect(hiddenTags).toHaveLength(10000);
      const id = createHash('sha256').update(realpathSync(path)).digest('hex');
      await new RepositoryPreferences(profile).save(id, { hiddenRefs: hiddenTags });
    }
    app = await electron.launch({ args });
    if (warm) {
      const prime = await app.firstWindow();
      await app.evaluate(({ dialog }, folder) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
      }, path);
      await prime.getByRole('button', { name: 'Open a repository', exact: true }).click();
      await expect(prime.getByTestId('commit-count')).toHaveText('2,000 commits · more available', {
        timeout: 60000,
      });
      for (const count of [7000, 12000, 17000]) {
        await prime.getByRole('button', { name: 'Load more commits', exact: true }).click();
        await expect(prime.getByTestId('commit-count')).toHaveText(
          `${count.toLocaleString('en-US')} commits · more available`,
        );
      }
      await app.close();
      app = await electron.launch({ args });
    }
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
    const firstPaintPhases = await page.evaluate(() => {
      const mark = (name: string) => performance.getEntriesByName(name).at(-1) as PerformanceMark;
      const response = mark('repository-snapshot-response');
      return {
        serviceMs: response.startTime - mark('repository-open-start').startTime,
        snapshotMs: response.detail.snapshotMs as number,
        workerMs: mark('repository-layout-response').startTime - response.startTime,
        publishMs:
          mark('repository-state-published').startTime -
          mark('repository-layout-response').startTime,
        paintMs:
          mark('repository-painted').startTime - mark('repository-state-published').startTime,
      };
    });
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
    const mountedReferences = await page.locator('.refs .ref').count();
    await page.getByRole('button', { name: 'Load more commits', exact: true }).click();
    await expect(page.getByTestId('commit-count')).toHaveText('17,000 commits · more available');
    pages.push(
      await page.evaluate(() => performance.getEntriesByName('history-page').at(-1)!.duration),
    );
    const pagingPhases = await page.evaluate(() => {
      const marks = (name: string) => performance.getEntriesByName(name).map((m) => m.startTime);
      const starts = marks('history-page-start'),
        responses = marks('history-page-response'),
        workers = marks('history-page-worker'),
        loaded = marks('history-page-loaded');
      return starts.map((start, i) => ({
        serviceMs: responses[i]! - start,
        workerMs: workers[i]! - responses[i]!,
        publishMs: loaded[i]! - workers[i]!,
      }));
    });
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
      refs: git('for-each-ref', '--format=.').split('\n').filter(Boolean).length,
      shallow: git('rev-parse', '--is-shallow-repository'),
      git: git('--version'),
      platform: `${process.platform} ${process.arch} ${release()}`,
      cpu: cpus()[0]?.model,
      hiddenRefCount: hiddenTags.length,
      firstPaintMs,
      firstPaintPhases,
      page5000Ms: pages,
      pagingPhases,
      scrollingRows: 12000,
      p95FrameMs,
      mountedRows,
      mountedReferences,
      electronMemory: memory,
      cache: {
        os: 'Not cleared',
        profile: warm
          ? 'Reopened after caching 17,000 commits and a complete app restart'
          : 'Fresh profile',
        gitCommitGraph:
          existsSync(
            git('rev-parse', '--path-format=absolute', '--git-path', 'objects/info/commit-graph'),
          ) ||
          existsSync(
            git(
              'rev-parse',
              '--path-format=absolute',
              '--git-path',
              'objects/info/commit-graphs/commit-graph-chain',
            ),
          ),
      },
    };
    console.log(JSON.stringify(measurement, null, 2));
    const metricsPath = testInfo.outputPath('metrics.json');
    writeFileSync(metricsPath, JSON.stringify(measurement, null, 2) + '\n');
    await testInfo.attach('real-repository-benchmark.json', {
      path: metricsPath,
      contentType: 'application/json',
    });
    await page.screenshot({ path: testInfo.outputPath('real-repository.png') });
    if (hiddenTags.length) {
      // Check the saved view after taking timings and the screenshot.
      const name = hiddenTags[0]!;
      await page.getByLabel('Filter references').fill(name);
      await expect(page.getByRole('button', { name: `Hide ${name}`, exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    }
    expect(mountedRows).toBeLessThan(100);
    expect.soft(mountedReferences).toBeLessThan(100);
    expect.soft(firstPaintMs).toBeLessThan(500);
    for (const pageMs of pages) expect.soft(pageMs).toBeLessThan(300);
    // 60 Hz is ~16.67 ms; allow 2 ms scheduling jitter in the headless runner.
    expect.soft(p95FrameMs).toBeLessThan(18.7);
  } finally {
    await app?.close();
    rmSync(profile, { recursive: true, force: true });
  }
});
