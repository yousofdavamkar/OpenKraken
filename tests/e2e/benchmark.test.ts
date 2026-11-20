import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { RepositoryPreferences } from '../../packages/git-core/src/preferences.js';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { cpus, release, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

async function scrollP95(element: HTMLElement | SVGElement) {
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
  const frames = samples.slice(2).sort((a, b) => a - b);
  return frames[Math.floor(frames.length * 0.95)]!;
}

async function loadHistory(app: ElectronApplication, path: string) {
  const page = await app.firstWindow();
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, path);
  await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
  const count = page.getByTestId('commit-count');
  await expect(count).toHaveText('2,000 commits · more available', { timeout: 60000 });
  for (const loaded of [7000, 12000, 17000]) {
    await page.getByRole('button', { name: 'Load more commits', exact: true }).click();
    await expect(count).toHaveText(`${loaded.toLocaleString('en-US')} commits · more available`);
  }
}

// The warm-up opens one repository in an otherwise empty profile.
function persistedWindowSize(profile: string) {
  const history = join(profile, 'history');
  expect(existsSync(history), 'Warm-up persisted a history window').toBe(true);
  const directories = readdirSync(history);
  expect(directories).toHaveLength(1);
  let offset = 0;
  let key: string | undefined;
  for (const name of ['prefix.json', 'tail-0.json', 'tail-1.json', 'tail-2.json']) {
    const file = join(history, directories[0]!, name);
    const page = JSON.parse(readFileSync(file, 'utf8'));
    if (offset === 0) {
      expect(page.key, name).toMatch(/^[0-9a-f]{64}$/);
      key = page.key;
    } else expect(page.key, name).toBe(key);
    expect(page.offset, name).toBe(offset);
    expect(Array.isArray(page.commits), name).toBe(true);
    expect(page.commits, name).toHaveLength(offset === 0 ? 2000 : 5000);
    offset += page.commits.length;
  }
  return offset;
}

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
    const soloRef = process.env.OPENKRAKEN_BENCH_SOLO_REF;
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
    }
    if (hiddenTags.length || soloRef) {
      const id = createHash('sha256').update(realpathSync(path)).digest('hex');
      await new RepositoryPreferences(profile).save(id, { hiddenRefs: hiddenTags, soloRef });
    }
    app = await electron.launch({ args });
    let persistedCommits: number | undefined;
    if (warm) {
      await loadHistory(app, path);
      await app.close();
      app = undefined;
      persistedCommits = persistedWindowSize(profile);
      app = await electron.launch({ args });
    }
    const fromRepository = process.env.OPENKRAKEN_BENCH_FROM_REPO;
    if (fromRepository) {
      const source = realpathSync(fromRepository);
      expect(source).not.toBe(realpathSync(path));
      await loadHistory(app, source);
    }
    const page = await app.firstWindow();
    const open = page.getByRole('button', {
      name: fromRepository ? 'Open repository' : 'Open a repository',
      exact: true,
    });
    await open.waitFor();
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, path);
    if (fromRepository) {
      await page.evaluate(() => {
        performance.clearMeasures('repository-first-paint');
        for (const mark of [
          'history-page-start',
          'history-page-response',
          'history-page-worker',
          'history-page-loaded',
        ])
          performance.clearMarks(mark);
      });
    }
    await open.click();
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
        responseMs: response.detail.receivedAt - mark('repository-open-start').startTime,
        jsonParseMs: response.detail.parseMs as number,
        refExpansionMs: response.detail.expandMs as number,
        workerMs: mark('repository-layout-response').startTime - response.startTime,
        publishMs:
          mark('repository-state-published').startTime -
          mark('repository-layout-response').startTime,
        paintMs:
          mark('repository-painted').startTime - mark('repository-state-published').startTime,
      };
    });
    await expect(page.getByTestId('commit-count')).toHaveText('2,000 commits · more available');
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
    const p95FrameMs = await grid.evaluate(scrollP95);
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
    const referenceList = page.getByRole('list', { name: 'Reference list', exact: true });
    let sidebarScrollP95Ms: number | undefined;
    if (await referenceList.count()) {
      sidebarScrollP95Ms = await referenceList.evaluate(scrollP95);
      await referenceList.evaluate((element) => {
        element.scrollTop = 0;
      });
    }
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: path, encoding: 'utf8', timeout: 30000 }).trim();
    const measurement = {
      repository: path,
      head: git('rev-parse', 'HEAD'),
      commits: Number(git('rev-list', '--count', 'HEAD')),
      commitsFromAllRefs: Number(git('rev-list', '--count', '--all')),
      refs: git('for-each-ref', '--format=.').split('\n').filter(Boolean).length,
      shallow: git('rev-parse', '--is-shallow-repository'),
      git: git('--version'),
      platform: `${process.platform} ${process.arch} ${release()}`,
      cpu: cpus()[0]?.model,
      hiddenRefCount: hiddenTags.length,
      ...(fromRepository && { switchedFrom: realpathSync(fromRepository), previousCommits: 17000 }),
      soloRef,
      firstPaintMs,
      firstPaintPhases,
      page5000Ms: pages,
      pagingPhases,
      scrollingRows: 12000,
      p95FrameMs,
      mountedRows,
      mountedReferences,
      sidebarScrollP95Ms,
      electronMemory: memory,
      cache: {
        os: 'Not cleared',
        persistedCommits,
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
    const alias = process.env.OPENKRAKEN_BENCH_ALIAS_REF;
    if (alias) {
      const commit = git('rev-parse', '--verify', alias + '^{commit}');
      const object = git('rev-parse', '--verify', alias);
      const count = git('for-each-ref', '--format=.', '--points-at=' + object).split('\n').length;
      await grid.press('Home');
      const first = grid.getByRole('row', { selected: true });
      await expect(first).toHaveAttribute('aria-rowindex', '1');
      await expect(first).toHaveAttribute('data-oid', commit);
      const opener = first.getByRole('button', {
        name: `Show all ${count.toLocaleString()} references for commit ${commit.slice(0, 8)}`,
        exact: true,
      });
      await opener.press('Enter');
      const dialog = page.getByRole('dialog', { name: 'Commit references' });
      await dialog.getByRole('textbox', { name: 'Filter commit references' }).fill(alias);
      await expect(dialog.getByRole('listitem')).toHaveText(alias);
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(opener).toBeFocused();
    }
    if (hiddenTags.length) {
      // Check the saved view after taking timings and the screenshot.
      const name = hiddenTags[0]!;
      await page.getByLabel('Filter references').fill(name);
      await expect(page.getByRole('button', { name: `Hide ${name}`, exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    }
    if (soloRef)
      await expect(page.getByLabel('Active graph view', { exact: true })).toContainText(
        `Solo: ${soloRef}`,
      );
    await expect(
      page.getByRole('heading', { name: `References ${measurement.refs}`, exact: true }),
    ).toBeVisible();
    expect(mountedRows).toBeGreaterThan(0);
    if (measurement.refs) expect(mountedReferences).toBeGreaterThan(0);
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
