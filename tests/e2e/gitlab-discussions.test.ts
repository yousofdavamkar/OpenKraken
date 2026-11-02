import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fixtureProtection } from './provider-fixtures.js';
import { gitlabDiscussionFixture, gitlabMergeFixture } from '../gitlab-fixtures.js';

test('GitLab discussions page, navigate nested replies and preserve inline context across refresh', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-gitlab-discussions-ui-'));
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    await fixtureProtection(app);
    await app.evaluate(
      ({ session }, { merge, discussion }) => {
        const state = {
          updated: false,
          fail: false,
          block: false,
          started: false,
          cancelled: false,
          pages: [] as number[],
        };
        Object.assign(globalThis, { gitlabDiscussions: state });
        session.fromPartition('openkraken-providers').fetch = async (input, init) => {
          const url = new URL(String(input));
          if (
            url.origin !== 'https://gitlab.com' ||
            new Headers(init?.headers).get('authorization') !== 'Bearer discussion-secret' ||
            init?.redirect !== 'error' ||
            init.credentials !== 'omit'
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
              diff_refs: { ...merge.diff_refs, start_sha: (state.updated ? '4' : '3').repeat(40) },
            });
          if (url.pathname === '/api/v4/projects/77/merge_requests/7/discussions') {
            if (state.block) {
              state.started = true;
              await new Promise<void>((resolve) => {
                if (init?.signal?.aborted) resolve();
                else init?.signal?.addEventListener('abort', () => resolve(), { once: true });
              });
              state.cancelled = true;
            }
            if (state.fail) return Response.json({ message: 'discussion-secret' }, { status: 503 });
            const page = Number(url.searchParams.get('page'));
            state.pages.push(page);
            const thread = (id: number) => ({
              ...discussion,
              id: id.toString(16).padStart(40, '0'),
              notes: [
                {
                  ...discussion.notes[0],
                  id: id * 10,
                  body:
                    id === 101
                      ? `Needle <script>discussion</script>${state.updated ? ' updated' : ''}`
                      : `Thread ${id}`,
                },
              ],
            });
            const selected = thread(101);
            return Response.json(
              page === 1
                ? Array.from({ length: 100 }, (_, i) => thread(i + 1))
                : [
                    thread(100),
                    {
                      ...selected,
                      notes: [
                        ...selected.notes,
                        ...Array.from({ length: state.updated ? 101 : 100 }, (_, i) => ({
                          ...discussion.notes[0],
                          id: 1011 + i,
                          type: 'DiscussionNote',
                          position: null,
                          body: `Reply ${i + 1}`,
                          author: null,
                          resolved: true,
                          resolved_by: { username: 'maintainer' },
                          resolved_at: '2026-10-03T00:00:00Z',
                        })),
                      ],
                    },
                  ],
            );
          }
          throw new Error('Unexpected endpoint');
        };
      },
      { merge: gitlabMergeFixture(7), discussion: gitlabDiscussionFixture() },
    );
    const page = await app.firstWindow();
    await page.clock.install();
    await page.evaluate(() =>
      window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'providerConnect',
        options: { provider: 'gitlab', origin: 'https://gitlab.com', token: 'discussion-secret' },
      }),
    );
    await page.getByRole('button', { name: 'Pull requests', exact: true }).click();
    await page.getByRole('option', { name: 'Select group/subgroup/project', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Browse merge requests' });
    await dialog
      .getByRole('option', { name: 'Open merge request !7: Merge 7', exact: true })
      .click();
    const detail = dialog.getByRole('region', { name: 'Merge-request details', exact: true });
    await expect(detail.getByRole('button', { name: 'Discussions', exact: true })).toBeVisible();
    await detail.getByRole('button', { name: 'Discussions', exact: true }).click();
    const browser = detail.getByRole('region', { name: 'Merge-request discussions', exact: true });
    await expect(browser.getByRole('status')).toContainText('100 discussions loaded');
    const list = browser.getByRole('listbox', { name: 'Discussions', exact: true });
    expect(await list.getByRole('option').count()).toBeLessThan(20);
    await browser.getByRole('button', { name: 'Load more discussions', exact: true }).click();
    await expect(browser.getByRole('status')).toContainText('101 discussions loaded');
    await browser.getByLabel('Search loaded discussions', { exact: true }).fill('Needle');
    await list.focus();
    await list.press('End');
    await list.press('Enter');
    const selected = browser.getByRole('region', { name: 'Selected discussion', exact: true });
    await expect(selected.getByRole('heading')).toHaveText('Discussion #1010');
    await expect(selected).toContainText('101 notes');
    const notes = selected.getByRole('list', { name: 'Discussion notes', exact: true });
    expect(await notes.getByRole('listitem').count()).toBeLessThan(20);
    await expect(notes).toContainText('Needle <script>discussion</script>');
    await expect(notes.locator('script')).toHaveCount(0);
    await notes.getByRole('button', { name: 'Show diff context for note #1010' }).click();
    await expect(notes).toContainText('Matches displayed diff');
    await expect(notes).toContainText('New line 12');
    await notes.focus();
    await notes.press('End');
    await expect(notes).toContainText('Reply 100');
    await expect(notes).toContainText('Deleted account');
    await expect(notes).toContainText('Resolved by maintainer');
    await notes.press('Home');
    await expect(
      notes.getByRole('button', { name: 'Hide diff context for note #1010' }),
    ).toBeVisible();
    await app.evaluate(() => {
      (
        globalThis as typeof globalThis & { gitlabDiscussions: { updated: boolean } }
      ).gitlabDiscussions.updated = true;
    });
    await dialog.getByLabel('Automatic refresh', { exact: true }).selectOption('1');
    await page.clock.fastForward(60000);
    await expect(selected).toContainText('102 notes');
    await expect(notes).toContainText('Different diff revision');
    await expect(notes).toContainText('Needle <script>discussion</script> updated');
    await expect(
      notes.getByRole('button', { name: 'Hide diff context for note #1010' }),
    ).toBeVisible();
    await expect(browser.getByLabel('Search loaded discussions', { exact: true })).toHaveValue(
      'Needle',
    );
    await expect(list.getByRole('option', { selected: true })).toContainText('Needle');
    expect(
      await app.evaluate(
        () =>
          (globalThis as typeof globalThis & { gitlabDiscussions: { pages: number[] } })
            .gitlabDiscussions.pages,
      ),
    ).toEqual([1, 2, 1, 2]);
    await dialog.getByLabel('Automatic refresh', { exact: true }).selectOption('0');
    await app.evaluate(() => {
      (
        globalThis as typeof globalThis & { gitlabDiscussions: { fail: boolean } }
      ).gitlabDiscussions.fail = true;
    });
    await browser.getByRole('button', { name: 'Refresh discussions', exact: true }).click();
    await expect(browser.getByRole('alert')).toContainText('GitLab request failed');
    await expect(browser).not.toContainText('discussion-secret');
    await app.evaluate(() => {
      (
        globalThis as typeof globalThis & { gitlabDiscussions: { fail: boolean } }
      ).gitlabDiscussions.fail = false;
    });
    await browser.getByRole('button', { name: 'Retry discussions', exact: true }).click();
    await expect(browser.getByRole('status')).toContainText('100 discussions loaded');
    await app.evaluate(() => {
      (
        globalThis as typeof globalThis & { gitlabDiscussions: { block: boolean } }
      ).gitlabDiscussions.block = true;
    });
    await browser.getByRole('button', { name: 'Refresh discussions', exact: true }).click();
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (globalThis as typeof globalThis & { gitlabDiscussions: { started: boolean } })
              .gitlabDiscussions.started,
        ),
      )
      .toBe(true);
    await detail.getByRole('button', { name: 'Details', exact: true }).click();
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (globalThis as typeof globalThis & { gitlabDiscussions: { cancelled: boolean } })
              .gitlabDiscussions.cancelled,
        ),
      )
      .toBe(true);
    await expect(browser).toHaveCount(0);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
