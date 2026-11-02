import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fixtureProtection } from './provider-fixtures.js';
import { gitlabDiscussionFixture, gitlabMergeFixture } from '../gitlab-fixtures.js';

test('GitLab discussion actions confirm frozen drafts, reject stale reviews and inspect uncertain replies', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-gitlab-actions-ui-'));
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    await fixtureProtection(app);
    await app.evaluate(
      ({ session }, { merge, discussion }) => {
        type Note = Omit<(typeof discussion.notes)[number], 'position'> & {
          position: (typeof discussion.notes)[number]['position'] | null;
        };
        type Discussion = Omit<typeof discussion, 'notes'> & { notes: Note[] };
        const state = {
          stale: false,
          block: false,
          started: false,
          uncertain: false,
          writes: [] as { method: string; body: unknown }[],
          discussions: [discussion] as Discussion[],
        };
        Object.assign(globalThis, { gitlabActions: state });
        session.fromPartition('openkraken-providers').fetch = async (input, init) => {
          const url = new URL(String(input));
          const method = init?.method ?? 'GET';
          if (
            url.origin !== 'https://gitlab.com' ||
            new Headers(init?.headers).get('authorization') !== 'Bearer discussion-secret' ||
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
          if (url.pathname === '/api/v4/projects/77/merge_requests/7')
            return Response.json({
              ...merge,
              title: state.stale ? 'Updated merge title' : merge.title,
            });
          const base = '/api/v4/projects/77/merge_requests/7/discussions';
          if (url.pathname === base && method === 'GET') return Response.json(state.discussions);
          if (url.pathname === `${base}/${discussion.id}` && method === 'GET')
            return Response.json(state.discussions[0]);
          if (method !== 'GET') {
            if (state.block) {
              state.started = true;
              await new Promise<void>((resolve) => {
                if (init?.signal?.aborted) resolve();
                else init?.signal?.addEventListener('abort', () => resolve(), { once: true });
              });
              throw new DOMException('Aborted', 'AbortError');
            }
            const body = init?.body ? JSON.parse(String(init.body)) : {};
            state.writes.push({ method, body });
            if (url.pathname === base && method === 'POST') {
              const created = {
                ...discussion,
                id: 'a'.repeat(40),
                notes: [
                  {
                    ...discussion.notes[0]!,
                    id: 20,
                    type: 'DiscussionNote',
                    position: null,
                    body: body.body,
                  },
                ],
              };
              state.discussions.push(created);
              return Response.json(created, { status: 201 });
            }
            if (url.pathname === `${base}/${discussion.id}/notes` && method === 'POST') {
              const note = {
                ...discussion.notes[0]!,
                id: 11,
                type: 'DiscussionNote',
                position: null,
                body: body.body,
              };
              state.discussions[0]!.notes.push(note);
              if (state.uncertain)
                return Response.json({ message: 'discussion-secret' }, { status: 503 });
              return Response.json(note, { status: 201 });
            }
            if (url.pathname === `${base}/${discussion.id}` && method === 'PUT') {
              const resolved = url.searchParams.get('resolved') === 'true';
              state.discussions[0]!.notes.forEach((note) => {
                note.resolved = resolved;
              });
              return Response.json(state.discussions[0]);
            }
          }
          throw new Error('Unexpected endpoint');
        };
      },
      { merge: gitlabMergeFixture(7), discussion: gitlabDiscussionFixture() },
    );
    const page = await app.firstWindow();
    await page.evaluate(() =>
      window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'providerConnect',
        options: { provider: 'gitlab', origin: 'https://gitlab.com', token: 'discussion-secret' },
      }),
    );
    await page.getByRole('button', { name: 'Pull requests', exact: true }).click();
    await page.getByRole('option', { name: 'Select group/subgroup/project', exact: true }).click();
    const browser = page.getByRole('dialog', { name: 'Browse merge requests', exact: true });
    await browser
      .getByRole('option', { name: 'Open merge request !7: Merge 7', exact: true })
      .click();
    await browser.getByRole('button', { name: 'Discussions', exact: true }).click();
    await browser.getByRole('button', { name: 'New discussion', exact: true }).click();
    const action = page.getByRole('dialog', { name: 'GitLab discussion action', exact: true });
    await action.getByLabel('Comment', { exact: true }).fill('New <script>discussion</script>');
    await action.getByRole('button', { name: 'Review discussion action', exact: true }).click();
    await expect(action.getByRole('region', { name: 'Confirm discussion action' })).toContainText(
      'New <script>discussion</script>',
    );
    await expect(action.getByLabel('Comment', { exact: true })).toBeDisabled();
    expect(
      await app.evaluate(
        () =>
          (globalThis as typeof globalThis & { gitlabActions: { writes: unknown[] } }).gitlabActions
            .writes.length,
      ),
    ).toBe(0);
    await app.evaluate(() => {
      (
        globalThis as typeof globalThis & { gitlabActions: { stale: boolean } }
      ).gitlabActions.stale = true;
    });
    await action.getByRole('button', { name: 'Confirm discussion action', exact: true }).click();
    await expect(action.getByRole('alert')).toContainText('changed');
    await expect(action.getByLabel('Comment', { exact: true })).toHaveValue(
      'New <script>discussion</script>',
    );
    await action.getByRole('button', { name: 'Review discussion action', exact: true }).click();
    await expect(action).toContainText('Updated merge title');
    await action.getByRole('button', { name: 'Confirm discussion action', exact: true }).click();
    await expect(action.getByRole('status')).toContainText('Created discussion #20');
    await action.getByRole('button', { name: 'Close action', exact: true }).click();
    await browser.getByRole('option', { name: 'Open discussion #10', exact: true }).click();
    await browser.getByRole('button', { name: 'Reply to discussion', exact: true }).click();
    await action.getByLabel('Comment', { exact: true }).fill('Reply kept after uncertainty');
    await action.getByRole('button', { name: 'Review discussion action', exact: true }).click();
    await expect(action).toContainText('Literal <script>discussion</script>');
    await app.evaluate(() => {
      (
        globalThis as typeof globalThis & { gitlabActions: { uncertain: boolean } }
      ).gitlabActions.uncertain = true;
    });
    await action.getByRole('button', { name: 'Confirm discussion action', exact: true }).click();
    await expect(action.getByRole('region', { name: 'Uncertain discussion action' })).toBeVisible();
    await expect(
      action.getByRole('button', { name: 'Confirm discussion action', exact: true }),
    ).toHaveCount(0);
    await action.getByRole('button', { name: 'Check existing results', exact: true }).click();
    await expect(
      action.getByRole('region', { name: 'Existing results', exact: true }),
    ).toContainText('Reply kept after uncertainty');
    expect(
      await app.evaluate(
        () =>
          (globalThis as typeof globalThis & { gitlabActions: { writes: unknown[] } }).gitlabActions
            .writes.length,
      ),
    ).toBe(2);
    await action.getByRole('button', { name: 'Close action', exact: true }).click();
    await expect(action.getByRole('region', { name: 'Discard discussion draft' })).toBeVisible();
    await action.getByRole('button', { name: 'Keep draft', exact: true }).click();
    await expect(action.getByLabel('Comment', { exact: true })).toHaveValue(
      'Reply kept after uncertainty',
    );
    await action.getByRole('button', { name: 'Close action', exact: true }).click();
    await action.getByRole('button', { name: 'Discard draft', exact: true }).click();
    await browser.getByRole('button', { name: 'Resolve discussion', exact: true }).click();
    await action.getByRole('button', { name: 'Review discussion action', exact: true }).click();
    await action.getByRole('button', { name: 'Confirm discussion action', exact: true }).click();
    await expect(action.getByRole('status')).toContainText('Discussion resolved');
    await action.getByRole('button', { name: 'Close action', exact: true }).click();
    await browser.getByRole('button', { name: 'Reopen discussion', exact: true }).click();
    await action.getByRole('button', { name: 'Review discussion action', exact: true }).click();
    await action.getByRole('button', { name: 'Confirm discussion action', exact: true }).click();
    await expect(action.getByRole('status')).toContainText('Discussion reopened');
    await action.getByRole('button', { name: 'Close action', exact: true }).click();
    await browser.getByRole('button', { name: 'New discussion', exact: true }).click();
    await action.getByLabel('Comment', { exact: true }).fill('Keep cancelled draft');
    await action.getByRole('button', { name: 'Review discussion action', exact: true }).click();
    await app.evaluate(() => {
      (
        globalThis as typeof globalThis & { gitlabActions: { block: boolean } }
      ).gitlabActions.block = true;
    });
    await action.getByRole('button', { name: 'Confirm discussion action', exact: true }).click();
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (globalThis as typeof globalThis & { gitlabActions: { started: boolean } })
              .gitlabActions.started,
        ),
      )
      .toBe(true);
    await action.getByRole('button', { name: 'Cancel request', exact: true }).click();
    await expect(
      action.getByRole('region', { name: 'Uncertain discussion action', exact: true }),
    ).toBeVisible();
    await expect(action.getByLabel('Comment', { exact: true })).toHaveValue('Keep cancelled draft');
    await action.press('Escape');
    await expect(
      action.getByRole('region', { name: 'Discard discussion draft', exact: true }),
    ).toBeVisible();
    await expect(browser).toBeVisible();
    await action.getByRole('button', { name: 'Keep draft', exact: true }).click();
    await expect(action.locator('script')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('discussion-secret');
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
