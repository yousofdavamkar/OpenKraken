import { verifyMergeRecovery } from './merge-recovery.js';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fixtureProtection } from './provider-fixtures.js';
import { gitlabMergeFixture } from '../gitlab-fixtures.js';
async function configure(app: ElectronApplication) {
  await fixtureProtection(app);
  await app.evaluate(({ session }, merge) => {
    const state = {
      base: '4'.repeat(40),
      squashPolicy: 'default_off',
      uncertain: false,
      block: false,
      started: false,
      writes: [] as unknown[],
      merge: {
        ...merge,
        detailed_merge_status: 'mergeable',
        user: { can_merge: true },
        squash: false,
        squash_on_merge: false,
        force_remove_source_branch: false,
        should_remove_source_branch: false,
        merge_when_pipeline_succeeds: false,
        merged_at: null as string | null,
      },
    };
    Object.assign(globalThis, { mergeAction: state });
    session.fromPartition('openkraken-providers').fetch = async (input, init) => {
      const url = new URL(String(input));
      if (
        url.origin !== 'https://gitlab.com' ||
        new Headers(init?.headers).get('authorization') !== 'Bearer merge-secret' ||
        init?.redirect !== 'error' ||
        init?.credentials !== 'omit'
      )
        throw new Error('Unexpected request');
      if (url.pathname === '/api/v4/user')
        return Response.json({ id: 73, username: 'contributor' });
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
        return Response.json({
          id: 77,
          path_with_namespace: 'group/subgroup/project',
          archived: false,
          merge_method: 'merge',
          squash_option: state.squashPolicy,
          only_allow_merge_if_pipeline_succeeds: true,
          only_allow_merge_if_all_discussions_are_resolved: true,
        });
      if (url.pathname === '/api/v4/projects/77/merge_requests')
        return Response.json(state.merge.state === 'opened' ? [state.merge] : []);
      const path = `/api/v4/projects/77/merge_requests/${state.merge.iid}`;
      if (url.pathname === path) return Response.json(state.merge);
      if (url.pathname === '/api/v4/projects/88/repository/branches/feature')
        return Response.json({
          name: 'feature',
          commit: { id: '1'.repeat(40) },
          protected: false,
          default: false,
        });
      if (url.pathname === '/api/v4/projects/77/repository/branches/main') {
        if (state.block) {
          state.started = true;
          await new Promise<void>((resolve) => {
            if (init?.signal?.aborted) resolve();
            else init?.signal?.addEventListener('abort', () => resolve(), { once: true });
          });
          throw new DOMException('Aborted', 'AbortError');
        }
        return Response.json({
          name: 'main',
          commit: { id: state.base },
          protected: true,
          default: true,
        });
      }
      if (url.pathname === `${path}/merge` && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body));
        state.writes.push(body);
        state.merge.state = 'merged';
        state.merge.merged_at = '2026-11-02T00:00:00Z';
        state.merge.squash = body.squash;
        state.merge.squash_on_merge = body.squash;
        return state.uncertain
          ? Response.json({ message: 'merge-secret' }, { status: 503 })
          : Response.json({
              ...state.merge,
              merge_commit_sha: '5'.repeat(40),
              squash_commit_sha: body.squash ? '6'.repeat(40) : null,
            });
      }
      throw new Error('Unexpected endpoint');
    };
  }, gitlabMergeFixture(7));
}
async function openMerge(app: ElectronApplication) {
  const page = await app.firstWindow();
  await page.evaluate(() =>
    window.openkraken.request({
      id: crypto.randomUUID(),
      method: 'providerConnect',
      options: { provider: 'gitlab', origin: 'https://gitlab.com', token: 'merge-secret' },
    }),
  );
  await page.getByRole('button', { name: 'Pull requests', exact: true }).click();
  await page.getByRole('option', { name: 'Select group/subgroup/project', exact: true }).click();
  const browser = page.getByRole('dialog', { name: 'Browse merge requests', exact: true });
  await browser
    .getByRole('option', { name: 'Open merge request !7: Merge 7', exact: true })
    .click();
  await browser.getByRole('button', { name: 'Review MR merge', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Merge GitLab request', exact: true });
  return { page, browser, dialog };
}
test('GitLab direct merge reviews policy and actual tips, preserves stale messages and checks uncertain completion without retrying', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-gitlab-merge-ui-'));
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    await configure(app);
    const { page, browser, dialog } = await openMerge(app);
    await expect(dialog).toContainText('Merge commit');
    await dialog.getByLabel('Squash commits', { exact: true }).check();
    await dialog.getByLabel('Use GitLab commit messages', { exact: true }).uncheck();
    await dialog
      .getByRole('textbox', { name: 'Merge commit message', exact: true })
      .fill('Merge <script>literal</script>');
    await dialog
      .getByRole('textbox', { name: 'Squash commit message', exact: true })
      .fill('Squash message');
    const squashChoice = dialog.getByLabel('Squash commits', { exact: true });
    const refresh = dialog.getByRole('button', { name: 'Refresh merge state', exact: true });
    await refresh.click();
    await expect(squashChoice).toBeEnabled();
    await expect(squashChoice).toBeChecked();
    for (const policy of ['never', 'always', 'default_off']) {
      await app.evaluate((_, policy) => {
        (
          globalThis as typeof globalThis & { mergeAction: { squashPolicy: string } }
        ).mergeAction.squashPolicy = policy;
      }, policy);
      await refresh.click();
      await expect(dialog.getByRole('region', { name: 'GitLab merge state' })).toContainText(
        policy,
      );
      await expect(squashChoice).toBeChecked({ checked: policy !== 'never' });
      await expect(squashChoice).toBeEnabled({ enabled: policy === 'default_off' });
    }
    await dialog.getByRole('button', { name: 'Review merge options', exact: true }).click();
    const review = dialog.getByRole('region', { name: 'Confirm GitLab merge', exact: true });
    await expect(review).toContainText('4'.repeat(40));
    await expect(review).toContainText('Merge <script>literal</script>');
    await expect(
      dialog.getByRole('textbox', { name: 'Merge commit message', exact: true }),
    ).toBeDisabled();
    await app.evaluate(() => {
      (globalThis as typeof globalThis & { mergeAction: { base: string } }).mergeAction.base =
        '7'.repeat(40);
    });
    await dialog.getByRole('button', { name: 'Confirm GitLab merge', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('changed');
    await expect(
      dialog.getByRole('textbox', { name: 'Merge commit message', exact: true }),
    ).toHaveValue('Merge <script>literal</script>');
    expect(
      await app.evaluate(
        () =>
          (globalThis as typeof globalThis & { mergeAction: { writes: unknown[] } }).mergeAction
            .writes.length,
      ),
    ).toBe(0);
    await app.evaluate(() => {
      (globalThis as typeof globalThis & { mergeAction: { block: boolean } }).mergeAction.block =
        true;
    });
    await dialog.getByRole('button', { name: 'Review merge options', exact: true }).click();
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (globalThis as typeof globalThis & { mergeAction: { started: boolean } }).mergeAction
              .started,
        ),
      )
      .toBe(true);
    await dialog.getByRole('button', { name: 'Cancel request', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('cancelled');
    await dialog.getByRole('button', { name: 'Close merge', exact: true }).click();
    await dialog.getByRole('button', { name: 'Keep editing', exact: true }).click();
    await expect(
      dialog.getByRole('textbox', { name: 'Merge commit message', exact: true }),
    ).toHaveValue('Merge <script>literal</script>');
    await app.evaluate(() => {
      const state = (
        globalThis as typeof globalThis & { mergeAction: { block: boolean; uncertain: boolean } }
      ).mergeAction;
      state.block = false;
      state.uncertain = true;
    });
    await dialog.getByRole('button', { name: 'Review merge options', exact: true }).click();
    await expect(review).toContainText('7'.repeat(40));
    await dialog.getByRole('button', { name: 'Confirm GitLab merge', exact: true }).click();
    await expect(
      dialog.getByRole('region', { name: 'Uncertain GitLab merge', exact: true }),
    ).toBeVisible();
    await dialog.getByRole('button', { name: 'Check current merge status', exact: true }).click();
    await expect(
      dialog.getByRole('region', { name: 'Observed merge status', exact: true }),
    ).toContainText('merged');
    expect(
      await app.evaluate(
        () =>
          (globalThis as typeof globalThis & { mergeAction: { writes: unknown[] } }).mergeAction
            .writes,
      ),
    ).toEqual([
      {
        sha: '1'.repeat(40),
        squash: true,
        should_remove_source_branch: false,
        auto_merge: false,
        merge_when_pipeline_succeeds: false,
        merge_commit_message: 'Merge <script>literal</script>',
        squash_commit_message: 'Squash message',
      },
    ]);
    await dialog.getByRole('button', { name: 'Close merge', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(
      browser.getByRole('option', { name: 'Open merge request !7: Merge 7', exact: true }),
    ).toHaveCount(0);
    await app.evaluate(() => {
      const state = (
        globalThis as typeof globalThis & {
          mergeAction: {
            uncertain: boolean;
            merge: {
              id: number;
              iid: number;
              title: string;
              state: string;
              merged_at: string | null;
            };
          };
        }
      ).mergeAction;
      state.uncertain = false;
      Object.assign(state.merge, {
        id: 1008,
        iid: 8,
        title: 'Merge 8',
        state: 'opened',
        merged_at: null,
      });
    });
    await browser.getByRole('button', { name: 'Refresh merge requests', exact: true }).click();
    await browser
      .getByRole('option', { name: 'Open merge request !8: Merge 8', exact: true })
      .click();
    await browser.getByRole('button', { name: 'Review MR merge', exact: true }).click();
    await dialog.getByRole('button', { name: 'Review merge options', exact: true }).click();
    await dialog.getByRole('button', { name: 'Confirm GitLab merge', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('Merged !8');
    await expect(dialog).toContainText('5'.repeat(40));
    await dialog.getByRole('button', { name: 'Close merge', exact: true }).click();
    await expect(
      browser.getByRole('option', { name: 'Open merge request !8: Merge 8', exact: true }),
    ).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('merge-secret');
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('GitLab recovers saved merge text and an interrupted merge after process death', async () => {
  await verifyMergeRecovery('gitlab', configure, async (app) => (await openMerge(app)).dialog);
});
