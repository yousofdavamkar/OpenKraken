import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fixtureProtection } from './provider-fixtures.js';
import { gitlabMergeFixture } from '../gitlab-fixtures.js';

test('GitLab approvals review current state, guard changed reviews and inspect uncertain revocations', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-gitlab-approvals-ui-'));
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    await fixtureProtection(app);
    await app.evaluate(({ session }, merge) => {
      const state = {
        changed: false,
        uncertain: false,
        block: false,
        started: false,
        posts: [] as { path: string; body: unknown }[],
        approvals: {
          id: 1007,
          iid: 7,
          project_id: 77,
          approved: false,
          user_can_approve: true,
          user_has_approved: false,
          approvals_required: 2,
          approvals_left: 1,
          require_password_to_approve: true,
          approval_rules_left: [
            { id: 9, name: 'Security <script>rule</script>', rule_type: 'code_owner' },
          ],
          invalid_approvers_rules: [],
          approved_by: Array.from({ length: 100 }, (_, index) => ({
            user: { id: 100 + index, username: `reviewer-${100 + index}` },
            approved_at: '2026-10-02T12:00:00Z',
          })),
        },
      };
      Object.assign(globalThis, { gitlabApprovals: state });
      session.fromPartition('openkraken-providers').fetch = async (input, init) => {
        const url = new URL(String(input));
        if (
          url.origin !== 'https://gitlab.com' ||
          new Headers(init?.headers).get('authorization') !== 'Bearer approval-secret' ||
          init?.redirect !== 'error' ||
          init?.credentials !== 'omit'
        )
          throw new Error('Unexpected request');
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
        if (url.pathname === '/api/v4/projects/77/merge_requests') return Response.json([merge]);
        const base = '/api/v4/projects/77/merge_requests/7';
        if (url.pathname === base) return Response.json(merge);
        if (url.pathname === `${base}/approvals`) {
          if (state.block) {
            state.started = true;
            await new Promise<void>((resolve) => {
              if (init?.signal?.aborted) resolve();
              else init?.signal?.addEventListener('abort', () => resolve(), { once: true });
            });
            throw new DOMException('Cancelled', 'AbortError');
          }
          return Response.json({
            ...state.approvals,
            approvals_left: state.changed ? 2 : state.approvals.approvals_left,
          });
        }
        if (url.pathname === `${base}/approve` || url.pathname === `${base}/unapprove`) {
          if (init?.method !== 'POST') throw new Error('Unexpected method');
          state.posts.push({ path: url.pathname, body: JSON.parse(String(init.body)) });
          const approve = url.pathname.endsWith('/approve');
          state.approvals.user_has_approved = approve;
          state.approvals.user_can_approve = !approve;
          state.approvals.approved_by = state.approvals.approved_by.filter(
            (entry) => entry.user.id !== 73,
          );
          if (approve)
            state.approvals.approved_by.push({
              user: { id: 73, username: 'fixture-user' },
              approved_at: '2026-10-03T00:00:00Z',
            });
          return state.uncertain
            ? Response.json({ message: 'approval-secret test-password' }, { status: 503 })
            : Response.json(state.approvals, { status: 201 });
        }
        throw new Error('Unexpected endpoint');
      };
    }, gitlabMergeFixture(7));
    const page = await app.firstWindow();
    await page.evaluate(() =>
      window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'providerConnect',
        options: { provider: 'gitlab', origin: 'https://gitlab.com', token: 'approval-secret' },
      }),
    );
    await page.getByRole('button', { name: 'Pull requests', exact: true }).click();
    await page.getByRole('option', { name: 'Select group/subgroup/project', exact: true }).click();
    const browser = page.getByRole('dialog', { name: 'Browse merge requests', exact: true });
    await browser
      .getByRole('option', { name: 'Open merge request !7: Merge 7', exact: true })
      .click();
    await browser.getByRole('button', { name: 'Approvals', exact: true }).click();
    const panel = browser.getByRole('region', { name: 'Merge-request approvals', exact: true });
    await expect(panel).toContainText('Required: 2 · Remaining: 1');
    const users = panel.getByRole('list', { name: 'Approving users', exact: true });
    expect(await users.getByRole('listitem').count()).toBeLessThan(20);
    await users.focus();
    await users.press('End');
    await expect(users).toContainText('reviewer-199');
    await panel.getByText('Unmet approval rules (1)', { exact: true }).click();
    await expect(panel).toContainText('Security <script>rule</script>');
    await panel.getByRole('button', { name: 'Approve merge request', exact: true }).click();
    const action = page.getByRole('dialog', { name: 'GitLab approval action', exact: true });
    await action.getByRole('button', { name: 'Review approval action', exact: true }).click();
    await expect(
      action.getByRole('region', { name: 'Confirm approval action', exact: true }),
    ).toContainText('1'.repeat(40));
    await action.getByLabel('Approval password', { exact: true }).fill('test-password');
    await app.evaluate(() => {
      (
        globalThis as typeof globalThis & { gitlabApprovals: { changed: boolean } }
      ).gitlabApprovals.changed = true;
    });
    await action.getByRole('button', { name: 'Confirm approval action', exact: true }).click();
    await expect(action.getByRole('alert')).toContainText('changed');
    await expect(action.getByLabel('Approval password', { exact: true })).toHaveValue('');
    expect(
      await app.evaluate(
        () =>
          (globalThis as typeof globalThis & { gitlabApprovals: { posts: unknown[] } })
            .gitlabApprovals.posts.length,
      ),
    ).toBe(0);
    await action.getByRole('button', { name: 'Review approval action', exact: true }).click();
    await action.getByLabel('Approval password', { exact: true }).fill('test-password');
    await action.getByRole('button', { name: 'Confirm approval action', exact: true }).click();
    await expect(action.getByRole('status')).toContainText('Approval recorded');
    expect(
      await app.evaluate(
        () =>
          (globalThis as typeof globalThis & { gitlabApprovals: { posts: unknown[] } })
            .gitlabApprovals.posts,
      ),
    ).toEqual([
      {
        path: '/api/v4/projects/77/merge_requests/7/approve',
        body: { sha: '1'.repeat(40), approval_password: 'test-password' },
      },
    ]);
    await action.getByRole('button', { name: 'Close action', exact: true }).click();
    await panel.getByRole('button', { name: 'Remove my approval', exact: true }).click();
    await expect(action.getByLabel('Approval password', { exact: true })).toHaveCount(0);
    await action.getByRole('button', { name: 'Review approval action', exact: true }).click();
    await app.evaluate(() => {
      (
        globalThis as typeof globalThis & { gitlabApprovals: { uncertain: boolean } }
      ).gitlabApprovals.uncertain = true;
    });
    await action.getByRole('button', { name: 'Confirm approval action', exact: true }).click();
    await expect(
      action.getByRole('region', { name: 'Uncertain approval action', exact: true }),
    ).toBeVisible();
    await action.getByRole('button', { name: 'Check existing approval', exact: true }).click();
    await expect(
      action.getByRole('region', { name: 'Existing approval', exact: true }),
    ).toContainText('Your approval: Not recorded');
    expect(
      await app.evaluate(
        () =>
          (globalThis as typeof globalThis & { gitlabApprovals: { posts: unknown[] } })
            .gitlabApprovals.posts.length,
      ),
    ).toBe(2);
    await action.getByRole('button', { name: 'Close action', exact: true }).click();
    await panel.getByRole('button', { name: 'Approve merge request', exact: true }).click();
    await app.evaluate(() => {
      (
        globalThis as typeof globalThis & { gitlabApprovals: { block: boolean } }
      ).gitlabApprovals.block = true;
    });
    await action.getByRole('button', { name: 'Review approval action', exact: true }).click();
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (globalThis as typeof globalThis & { gitlabApprovals: { started: boolean } })
              .gitlabApprovals.started,
        ),
      )
      .toBe(true);
    await action.getByRole('button', { name: 'Cancel request', exact: true }).click();
    await expect(action.getByRole('alert')).toContainText('cancelled');
    await expect(
      action.getByRole('button', { name: 'Confirm approval action', exact: true }),
    ).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('approval-secret');
    await expect(page.locator('body')).not.toContainText('test-password');
    await expect(panel.locator('script')).toHaveCount(0);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
