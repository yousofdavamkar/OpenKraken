import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fixtureProtection } from './provider-fixtures.js';
import { gitlabMergeFixture } from '../gitlab-fixtures.js';

test('GitLab pipelines and jobs page, search and refresh by commit without losing keyboard selection', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-gitlab-pipelines-ui-'));
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    await fixtureProtection(app);
    await app.evaluate(({ session }, merge) => {
      const state = {
        changed: false,
        updated: false,
        blocked: false,
        started: false,
        cancelled: false,
        pages: [] as number[],
        jobPages: [] as number[],
      };
      Object.assign(globalThis, { gitlabPipelines: state });
      const pipeline = (id: number) => ({
        id,
        project_id: 88,
        sha: (id === 9 ? '1' : '2').repeat(40),
        ref: 'feature',
        status: state.updated ? 'success' : 'running',
      });
      session.fromPartition('openkraken-providers').fetch = async (input, init) => {
        const url = new URL(String(input));
        if (
          url.origin !== 'https://gitlab.com' ||
          new Headers(init?.headers).get('authorization') !== 'Bearer pipeline-secret'
        )
          throw new Error('Unexpected provider request');
        if (url.pathname === '/api/v4/user')
          return Response.json({ id: 73, username: 'fixture-user' });
        if (url.pathname === '/api/v4/projects')
          return Response.json([
            {
              id: 77,
              path_with_namespace: 'group/subgroup/project',
              path: 'project',
              description: '',
              visibility: 'private',
              archived: false,
            },
          ]);
        if (url.pathname === '/api/v4/projects/group%2Fsubgroup%2Fproject')
          return Response.json({ id: 77, path_with_namespace: 'group/subgroup/project' });
        if (url.pathname === '/api/v4/projects/88')
          return Response.json({ id: 88, path_with_namespace: 'contributor/fork' });
        if (url.pathname === '/api/v4/projects/77/merge_requests') return Response.json([merge]);
        if (url.pathname === '/api/v4/projects/77/merge_requests/7')
          return Response.json({ ...merge, sha: (state.changed ? '4' : '1').repeat(40) });
        if (url.pathname === '/api/v4/projects/77/merge_requests/7/pipelines') {
          if (state.blocked) {
            state.started = true;
            await new Promise<void>((resolve) => {
              if (init?.signal?.aborted) resolve();
              else init?.signal?.addEventListener('abort', () => resolve(), { once: true });
            });
            state.cancelled = true;
          }
          const page = Number(url.searchParams.get('page'));
          state.pages.push(page);
          return Response.json(
            page === 1
              ? Array.from({ length: 100 }, (_, i) => pipeline(i + 1))
              : [pipeline(100), pipeline(101)],
          );
        }
        if (url.pathname === '/api/v4/projects/88/pipelines/9')
          return Response.json({
            ...pipeline(9),
            source: 'merge_request_event',
            duration: 4,
            queued_duration: 0.3,
          });
        if (url.pathname === '/api/v4/projects/88/pipelines/9/jobs') {
          const page = Number(url.searchParams.get('page'));
          state.jobPages.push(page);
          const job = (id: number) => ({
            id,
            name: id === 101 ? 'needle <script>literal</script>' : `Job ${id}`,
            stage: 'test',
            status: state.updated ? 'success' : 'failed',
            ref: 'feature',
            allow_failure: true,
            created_at: '2026-11-02T00:00:00Z',
            started_at: null,
            finished_at: null,
            duration: 1.5,
            queued_duration: null,
            failure_reason: state.updated ? null : 'script_failure',
            pipeline: pipeline(9),
            commit: { id: '1'.repeat(40) },
            web_url: 'https://attacker.test/ignored',
          });
          return Response.json(
            page === 1 ? Array.from({ length: 100 }, (_, i) => job(i + 1)) : [job(100), job(101)],
          );
        }
        throw new Error(`Unexpected endpoint ${url.pathname}`);
      };
    }, gitlabMergeFixture(7));
    const page = await app.firstWindow();
    await page.clock.install();
    await page.evaluate(() =>
      window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'providerConnect',
        options: { provider: 'gitlab', origin: 'https://gitlab.com', token: 'pipeline-secret' },
      }),
    );
    await page.getByRole('button', { name: 'Pull requests', exact: true }).click();
    await page.getByRole('option', { name: 'Select group/subgroup/project', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Browse merge requests' });
    await dialog
      .getByRole('option', { name: 'Open merge request !7: Merge 7', exact: true })
      .click();
    const detail = dialog.getByRole('region', { name: 'Merge-request details', exact: true });
    await detail.getByRole('button', { name: 'Pipelines', exact: true }).click();
    const pipelines = detail.getByRole('region', { name: 'Merge-request pipelines', exact: true });
    await expect(pipelines.getByRole('status', { name: 'Pipelines loaded' })).toContainText(
      '100 pipelines loaded',
    );
    const list = pipelines.getByRole('listbox', { name: 'Pipelines', exact: true });
    expect(await list.getByRole('option').count()).toBeLessThan(20);
    await pipelines.getByRole('button', { name: 'Load more pipelines', exact: true }).click();
    await expect(pipelines.getByRole('status', { name: 'Pipelines loaded' })).toContainText(
      '101 pipelines loaded',
    );
    const search = pipelines.getByRole('searchbox', { name: 'Search loaded pipelines' });
    await search.fill('#9 ');
    await list.focus();
    await list.press('Home');
    await list.press('Enter');
    const jobs = pipelines.getByRole('region', { name: 'Pipeline jobs', exact: true });
    await expect(jobs.getByRole('status', { name: 'Jobs loaded' })).toContainText(
      '100 jobs loaded',
    );
    await expect(jobs).toContainText('https://gitlab.com/contributor/fork/-/pipelines/9');
    expect(await jobs.getByRole('option').count()).toBeLessThan(20);
    await jobs.getByRole('button', { name: 'Load more jobs', exact: true }).click();
    await expect(jobs.getByRole('status', { name: 'Jobs loaded' })).toContainText(
      '101 jobs loaded',
    );
    const jobSearch = jobs.getByRole('searchbox', { name: 'Search loaded jobs' });
    await jobSearch.fill('needle');
    const jobList = jobs.getByRole('listbox', { name: 'Jobs', exact: true });
    await jobList.focus();
    await jobList.press('End');
    await jobList.press('Enter');
    const selected = jobs.getByRole('region', { name: 'Selected job' });
    await expect(selected).toContainText('needle <script>literal</script>');
    await expect(selected).toContainText('Failure allowed');
    await expect(selected).toContainText('script_failure');
    await expect(selected).toContainText('https://gitlab.com/contributor/fork/-/jobs/101');
    await expect(selected.locator('script')).toHaveCount(0);
    await app.evaluate(() => {
      (
        globalThis as typeof globalThis & { gitlabPipelines: { updated: boolean } }
      ).gitlabPipelines.updated = true;
    });
    await dialog.getByLabel('Automatic refresh', { exact: true }).selectOption('1');
    await page.clock.fastForward(60000);
    await expect(selected).toContainText('success');
    await expect(selected).not.toContainText('script_failure');
    await expect(jobSearch).toHaveValue('needle');
    await expect(jobList.getByRole('option', { selected: true })).toContainText('needle');
    expect(
      await app.evaluate(
        () =>
          (globalThis as typeof globalThis & { gitlabPipelines: { jobPages: number[] } })
            .gitlabPipelines.jobPages,
      ),
    ).toEqual([1, 2, 1, 2]);
    await dialog.getByLabel('Automatic refresh', { exact: true }).selectOption('0');
    await app.evaluate(() => {
      (
        globalThis as typeof globalThis & { gitlabPipelines: { changed: boolean } }
      ).gitlabPipelines.changed = true;
    });
    await dialog.getByLabel('Automatic refresh', { exact: true }).selectOption('1');
    await page.clock.fastForward(60000);
    await expect(jobs).toHaveCount(0);
    await expect(pipelines.getByRole('status', { name: 'Pipelines loaded' })).toContainText(
      '100 pipelines loaded',
    );
    await dialog.getByLabel('Automatic refresh', { exact: true }).selectOption('0');
    await search.fill('#9 ');
    await list.focus();
    await list.press('Home');
    await list.press('Enter');
    await expect(jobs.getByRole('status', { name: 'Jobs loaded' })).toContainText(
      '100 jobs loaded',
    );
    await app.evaluate(() => {
      (
        globalThis as typeof globalThis & { gitlabPipelines: { changed: boolean } }
      ).gitlabPipelines.changed = false;
    });
    await jobs.getByRole('button', { name: 'Refresh jobs', exact: true }).click();
    await expect(jobs.getByRole('alert')).toContainText('source commit changed');
    await expect(selected).toHaveCount(0);
    await detail.getByRole('button', { name: 'Refresh details', exact: true }).click();
    await expect(pipelines.getByRole('status', { name: 'Pipelines loaded' })).toContainText(
      '100 pipelines loaded',
    );
    await expect(jobs).toHaveCount(0);
    await app.evaluate(() => {
      (
        globalThis as typeof globalThis & { gitlabPipelines: { blocked: boolean } }
      ).gitlabPipelines.blocked = true;
    });
    await pipelines.getByRole('button', { name: 'Refresh pipelines', exact: true }).click();
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (globalThis as typeof globalThis & { gitlabPipelines: { started: boolean } })
              .gitlabPipelines.started,
        ),
      )
      .toBe(true);
    await detail.getByRole('button', { name: 'Details', exact: true }).click();
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (globalThis as typeof globalThis & { gitlabPipelines: { cancelled: boolean } })
              .gitlabPipelines.cancelled,
        ),
      )
      .toBe(true);
    await expect(pipelines).toHaveCount(0);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
