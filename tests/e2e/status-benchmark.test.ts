import { _electron as electron, expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, release, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const fixturePath = process.env.OPENKRAKEN_STATUS_BENCH_FIXTURE;
test('watcher-warm working-state requests meet the 300 ms status budget', async ({
  browserName: _browserName,
}, testInfo) => {
  test.skip(!fixturePath, 'Set OPENKRAKEN_STATUS_BENCH_FIXTURE to a generated scale fixture.json');
  test.setTimeout(120000);
  const manifestPath = realpathSync(fixturePath!);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const repository = realpathSync(join(dirname(manifestPath), 'repository'));
  expect(manifest).toMatchObject({
    format: 1,
    kind: 'openkraken-synthetic-scale',
    repository,
    statusProbe: 'status-probe.txt',
  });
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: repository,
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 32 * 1024 * 1024,
    }).trim();
  expect(git('status', '--porcelain')).toBe('');
  expect(git('rev-parse', 'HEAD')).toBe(manifest.head);
  const probe = join(repository, manifest.statusProbe);
  expect(lstatSync(probe).isFile()).toBe(true);
  const original = readFileSync(probe);
  const expected = execFileSync('git', ['show', 'HEAD:status-probe.txt'], { cwd: repository });
  expect(original).toEqual(expected);
  const profile = mkdtempSync(join(tmpdir(), 'openkraken-status-bench-'));
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${profile}`],
  });
  let modified = false;
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Open a repository', exact: true }).waitFor();
    await page.evaluate(() => {
      window.openkraken.subscribe((event) => {
        if (event.type === 'repositoryChanged' && event.mode === 'native')
          Reflect.set(window, '__statusBenchmarkRepository', event.repoId);
      });
    });
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, repository);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    await expect(page.getByText('Watching for changes', { exact: true })).toBeVisible({
      timeout: 60000,
    });
    const repoId: string = await page.evaluate(() =>
      Reflect.get(window, '__statusBenchmarkRepository'),
    );
    expect(repoId).toMatch(/^[0-9a-f]{64}$/);
    const measure = async () =>
      page.evaluate(async (id) => {
        const started = performance.now();
        const result = await window.openkraken.request({
          id: crypto.randomUUID(),
          method: 'workingState',
          repoId: id,
        });
        const elapsedMs = performance.now() - started;
        if (result.kind !== 'workingState')
          throw new Error(`Unexpected status result: ${result.kind}`);
        return { elapsedMs, entries: result.state.status.entries, head: result.state.head };
      }, repoId);
    // The warm-up is recorded separately; no measured sample is discarded as an outlier.
    const warmup = await measure();
    expect(warmup.entries).toEqual([]);
    const clean = [];
    for (let sample = 0; sample < 5; sample++) {
      const result = await measure();
      expect(result.entries).toEqual([]);
      clean.push(result.elapsedMs);
    }
    const loadedBefore = await page.getByTestId('commit-count').textContent();
    const editStarted = performance.now();
    writeFileSync(probe, Buffer.concat([original, Buffer.from('Benchmark working edit\n')]));
    modified = true;
    await expect(
      page.getByRole('button', { name: 'Stage status-probe.txt', exact: true }),
    ).toBeEnabled({ timeout: 10000 });
    const editToVisibleMs = performance.now() - editStarted;
    expect(await page.getByTestId('commit-count').textContent()).toBe(loadedBefore);
    const dirty = [];
    for (let sample = 0; sample < 5; sample++) {
      const result = await measure();
      expect(result.entries).toMatchObject([
        { path: 'status-probe.txt', index: '.', worktree: 'M' },
      ]);
      expect(result.head.oid).toBe(manifest.head);
      dirty.push(result.elapsedMs);
    }
    const measurement = {
      repository,
      head: manifest.head,
      commits: manifest.commits,
      files: manifest.files,
      git: git('--version'),
      platform: `${process.platform} ${process.arch} ${release()}`,
      cpu: cpus()[0]?.model,
      watcher: 'native',
      boundary:
        'Renderer request to validated workingState response, including native status, revision, commit and operation metadata; excludes watcher debounce and UI paint.',
      warmupMs: warmup.elapsedMs,
      cleanMs: clean,
      dirtyMs: dirty,
      editToVisibleMs,
      budgetMs: 300,
      externalEditBudgetMs: 1500,
      cache: {
        os: 'Not cleared',
        profile: 'Fresh profile',
        workingState: 'One explicit warm-up after native watcher readiness',
      },
    };
    console.log(JSON.stringify(measurement, null, 2));
    const metrics = testInfo.outputPath('metrics.json');
    writeFileSync(metrics, JSON.stringify(measurement, null, 2) + '\n');
    await testInfo.attach('watcher-warm-status.json', {
      path: metrics,
      contentType: 'application/json',
    });
    await page.screenshot({ path: testInfo.outputPath('working-status.png') });
    for (const elapsed of [...clean, ...dirty]) expect.soft(elapsed).toBeLessThan(300);
    expect.soft(editToVisibleMs).toBeLessThan(1500);
  } finally {
    try {
      await app.close();
    } finally {
      if (modified) writeFileSync(probe, original);
      rmSync(profile, { recursive: true, force: true });
    }
  }
  expect(git('status', '--porcelain')).toBe('');
});
