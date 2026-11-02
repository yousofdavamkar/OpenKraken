import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fixtureProtection } from './provider-fixtures.js';
import { gitlabMergeFixture } from '../gitlab-fixtures.js';

test('GitLab merge requests preserve native states, manual pages, keyboard selection and pending diff details', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-gitlab-merges-ui-'));
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    await fixtureProtection(app);
    await app.evaluate(({ session }, fixture) => {
      Object.assign(globalThis, {
        mergePending: false,
        mergePages: [] as number[],
        mergeFail: false,
        mergeBlock: false,
        mergeStarted: false,
        mergeAborted: false,
      });
      session.fromPartition('openkraken-providers').fetch = async (input, init) => {
        const url = new URL(String(input));
        if (
          url.origin !== 'https://code.example.test' ||
          new Headers(init?.headers).get('authorization') !== 'Bearer merge-secret' ||
          init?.redirect !== 'error' ||
          init.credentials !== 'omit'
        )
          throw new Error('Unexpected request');
        const flags = globalThis as typeof globalThis & {
          mergePending: boolean;
          mergePages: number[];
          mergeFail: boolean;
          mergeBlock: boolean;
          mergeStarted: boolean;
          mergeAborted: boolean;
        };
        if (url.pathname === '/api/v4/user')
          return Response.json({ id: 73, username: 'fixture-user' });
        if (url.pathname === '/api/v4/projects')
          return Response.json([
            {
              id: 77,
              path_with_namespace: 'group/subgroup/project',
              path: 'project',
              description: '',
              visibility: 'internal',
              archived: false,
            },
          ]);
        if (url.pathname === '/api/v4/projects/group%2Fsubgroup%2Fproject')
          return Response.json({ id: 77, path_with_namespace: 'group/subgroup/project' });
        const merge = (iid: number, state = 'opened') => ({
          ...fixture,
          iid,
          id: iid + 1000,
          state,
          title: iid === 101 ? 'Needle merge' : `Merge ${iid}`,
        });
        if (url.pathname === '/api/v4/projects/77/merge_requests') {
          flags.mergePages.push(Number(url.searchParams.get('page')));
          const state = url.searchParams.get('state')!;
          if (state !== 'opened') return Response.json([merge(201, state)]);
          return Response.json(
            url.searchParams.get('page') === '1'
              ? Array.from({ length: 100 }, (_, i) => merge(i + 1))
              : [merge(100), merge(101)],
          );
        }
        if (url.pathname === '/api/v4/projects/77/merge_requests/101') {
          if (flags.mergeBlock) {
            flags.mergeStarted = true;
            await new Promise<void>((resolve) => {
              if (init?.signal?.aborted) resolve();
              else init?.signal?.addEventListener('abort', () => resolve(), { once: true });
            });
            flags.mergeAborted = true;
          }
          if (flags.mergeFail) return Response.json({ message: 'merge-secret' }, { status: 503 });
          return Response.json({
            ...merge(101),
            ...(flags.mergePending
              ? { diff_refs: {}, changes_count: '', source_project_id: null, sha: null }
              : {}),
          });
        }
        throw new Error('Unexpected endpoint');
      };
    }, gitlabMergeFixture());
    const page = await app.firstWindow();
    await page.clock.install();
    expect(
      (
        await page.evaluate(() =>
          window.openkraken.request({
            id: crypto.randomUUID(),
            method: 'providerConnect',
            options: {
              provider: 'gitlab',
              origin: 'https://code.example.test',
              token: 'merge-secret',
            },
          }),
        )
      ).kind,
    ).toBe('providerAccounts');
    await page.getByRole('button', { name: 'Pull requests', exact: true }).click();
    await page.getByRole('option', { name: 'Select group/subgroup/project', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Browse merge requests' });
    await expect(dialog.getByRole('status')).toContainText('100 merge requests loaded');
    await expect(dialog.getByRole('button', { name: 'Create pull request' })).toHaveCount(0);
    const list = dialog.getByRole('listbox', { name: 'Merge requests', exact: true });
    expect(await list.getByRole('option').count()).toBeLessThan(20);
    await list.focus();
    await list.press('End');
    await expect(
      list.getByRole('option', { name: 'Open merge request !100: Merge 100', exact: true }),
    ).toHaveAttribute('aria-selected', 'true');
    await dialog.getByRole('button', { name: 'Load more merge requests' }).click();
    await expect(dialog.getByRole('status')).toContainText('101 merge requests loaded');
    await dialog.getByLabel('Search loaded merge requests').fill('!101');
    await expect(list.getByRole('option')).toHaveCount(1);
    await list.focus();
    await list.press('Enter');
    const details = dialog.getByRole('region', { name: 'Merge-request details' });
    await expect(details.getByRole('heading')).toHaveText('!101 Needle merge');
    await expect(details).toContainText('feature → main');
    await expect(details).toContainText('1000+ changes');
    await expect(details).toContainText('Merge status: checking');
    await expect(details.locator('.pull-body')).toContainText(
      'Literal <script>description</script>',
    );
    await expect(details.locator('script')).toHaveCount(0);
    await expect(details).toContainText(
      'https://code.example.test/group/subgroup/project/-/merge_requests/101',
    );
    await expect(details).toContainText('3'.repeat(40));
    await app.evaluate(() => Object.assign(globalThis, { mergePending: true }));
    await dialog.getByLabel('Automatic refresh', { exact: true }).selectOption('1');
    await page.clock.fastForward(60000);
    await expect(dialog.getByRole('status', { name: 'Automatic refresh status' })).toContainText(
      'Automatic refresh completed.',
    );
    expect(
      await app.evaluate(
        () => (globalThis as typeof globalThis & { mergePages: number[] }).mergePages,
      ),
    ).toEqual([1, 2, 1, 2]);
    await expect(dialog.getByLabel('Search loaded merge requests')).toHaveValue('!101');
    await expect(list.getByRole('option')).toHaveAttribute('aria-selected', 'true');
    await dialog.getByLabel('Automatic refresh', { exact: true }).selectOption('0');
    await expect(details).toContainText('Diff is still being prepared.');
    await expect(details).toContainText('Change count not yet available.');
    await expect(details).toContainText('Source project is no longer available.');
    await expect(details).not.toContainText('3'.repeat(40));
    await app.evaluate(() => Object.assign(globalThis, { mergeFail: true }));
    await details.getByRole('button', { name: 'Refresh details' }).click();
    await expect(details.getByRole('alert')).toContainText('GitLab request failed');
    await expect(dialog).not.toContainText('merge-secret');
    await app.evaluate(() => Object.assign(globalThis, { mergeFail: false }));
    await details.getByRole('button', { name: 'Retry details' }).click();
    await expect(details.getByRole('heading')).toBeVisible();
    for (const state of ['closed', 'merged', 'locked']) {
      await dialog.getByLabel('Merge-request state', { exact: true }).selectOption(state);
      await expect(list.getByRole('option')).toContainText(
        state[0]!.toUpperCase() + state.slice(1),
      );
      await expect(details).toHaveCount(0);
    }
    await dialog.getByLabel('Merge-request state', { exact: true }).selectOption('open');
    await dialog.getByRole('button', { name: 'Load more merge requests' }).click();
    await dialog.getByLabel('Search loaded merge requests').fill('Needle');
    await app.evaluate(() => Object.assign(globalThis, { mergeBlock: true }));
    await list.getByRole('option').click();
    await expect
      .poll(() =>
        app.evaluate(
          () => (globalThis as typeof globalThis & { mergeStarted: boolean }).mergeStarted,
        ),
      )
      .toBe(true);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect
      .poll(() =>
        app.evaluate(
          () => (globalThis as typeof globalThis & { mergeAborted: boolean }).mergeAborted,
        ),
      )
      .toBe(true);
    await expect(dialog).toHaveCount(0);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
