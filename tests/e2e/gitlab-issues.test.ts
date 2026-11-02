import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fixtureProtection } from './provider-fixtures.js';
import { gitlabIssueFixture, gitlabIssueNoteFixture } from '../gitlab-fixtures.js';

test('GitLab issues preserve native visibility and note activity through paging, keyboard navigation and refresh', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-gitlab-issues-ui-'));
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    await fixtureProtection(app);
    await app.evaluate(
      ({ session }, { issue, note }) => {
        const state = {
          updated: false,
          visible: true,
          fail: true,
          blocked: false,
          started: false,
          cancelled: false,
          pages: [] as number[],
          notesPages: [] as number[],
        };
        Object.assign(globalThis, { gitlabIssues: state });
        session.fromPartition('openkraken-providers').fetch = async (input, init) => {
          const url = new URL(String(input));
          if (
            url.origin !== 'https://gitlab.com' ||
            new Headers(init?.headers).get('authorization') !== 'Bearer issue-secret'
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
          if (url.pathname === '/api/v4/projects/77/issues') {
            if (state.fail) return Response.json({ message: 'issue-secret' }, { status: 503 });
            const page = Number(url.searchParams.get('page'));
            state.pages.push(page);
            if (url.searchParams.get('state') === 'closed')
              return Response.json([{ ...issue, state: 'closed' }]);
            return Response.json(
              page === 1
                ? Array.from({ length: 100 }, (_, i) => ({
                    ...issue,
                    id: 2001 + i,
                    iid: i + 1,
                    title: `Issue ${i + 1}`,
                  }))
                : [
                    { ...issue, id: 2100, iid: 100, title: 'Updated issue' },
                    { ...issue, id: 2101, iid: 101, title: 'Needle issue' },
                  ],
            );
          }
          if (url.pathname === '/api/v4/projects/77/issues/101')
            return Response.json({
              ...issue,
              id: 2101,
              iid: 101,
              title: 'Needle issue',
              confidential: state.visible,
              description: state.updated ? 'Refreshed description' : issue.description,
            });
          if (url.pathname === '/api/v4/projects/77/issues/7')
            return Response.json({ ...issue, state: 'closed' });
          if (url.pathname === '/api/v4/projects/77/issues/101/notes') {
            if (state.blocked) {
              state.started = true;
              await new Promise<void>((resolve) => {
                if (init?.signal?.aborted) resolve();
                else init?.signal?.addEventListener('abort', () => resolve(), { once: true });
              });
              state.cancelled = true;
            }
            const page = Number(url.searchParams.get('page'));
            state.notesPages.push(page);
            const value = (id: number) => ({
              ...note,
              id,
              noteable_id: 2101,
              noteable_iid: 101,
              system: id === 1,
              body: id === 101 ? (state.updated ? 'Refreshed last note' : 'Last note') : note.body,
            });
            return Response.json(
              page === 1
                ? Array.from({ length: 100 }, (_, i) => value(i + 1))
                : [value(100), value(101)],
            );
          }
          throw new Error(`Unexpected endpoint ${url.pathname}`);
        };
      },
      { issue: gitlabIssueFixture(7), note: gitlabIssueNoteFixture() },
    );
    const page = await app.firstWindow();
    await page.clock.install();
    await page.evaluate(() =>
      window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'providerConnect',
        options: { provider: 'gitlab', origin: 'https://gitlab.com', token: 'issue-secret' },
      }),
    );
    await page.getByRole('button', { name: 'Issues', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Browse issues' });
    await dialog
      .getByRole('option', { name: 'Select group/subgroup/project', exact: true })
      .click();
    await expect(dialog.getByRole('alert')).toContainText('GitLab request failed');
    await expect(dialog).not.toContainText('issue-secret');
    await app.evaluate(() => {
      (globalThis as typeof globalThis & { gitlabIssues: { fail: boolean } }).gitlabIssues.fail =
        false;
    });
    await dialog.getByRole('button', { name: 'Retry issues', exact: true }).click();
    await expect(dialog).toContainText('100 issues loaded');
    await expect(dialog.getByRole('button', { name: 'New issue', exact: true })).toHaveCount(0);
    const list = dialog.getByRole('listbox', { name: 'Issues', exact: true });
    expect(await list.getByRole('option').count()).toBeLessThan(30);
    await dialog.getByRole('button', { name: 'Load more issues', exact: true }).click();
    await expect(dialog).toContainText('101 issues loaded');
    const search = dialog.getByRole('searchbox', { name: 'Search loaded issues' });
    await search.fill('Needle');
    await list.focus();
    await list.press('End');
    await list.press('Enter');
    const detail = dialog.getByRole('region', { name: 'Issue details', exact: true });
    await expect(detail).toContainText('Confidential issue');
    await expect(detail).toContainText('incident');
    await expect(detail).toContainText('Conversation lock not reported');
    await expect(detail).toContainText('Due: 2026-11-10');
    await expect(detail).toContainText('Weight: 3');
    await expect(detail).toContainText('https://gitlab.com/group/subgroup/project/-/issues/101');
    await expect(detail).toContainText('Literal <script>issue</script>');
    await expect(detail.locator('script')).toHaveCount(0);
    await expect(
      detail.getByRole('button', { name: 'Write issue comment', exact: true }),
    ).toHaveCount(0);
    await detail.getByRole('button', { name: 'Notes', exact: true }).click();
    const notes = detail.getByRole('region', { name: 'Issue notes', exact: true });
    await expect(notes.getByRole('status')).toContainText('100 notes loaded');
    await expect(notes).toContainText('System activity');
    await expect(notes).toContainText('Internal note');
    await expect(notes).toContainText('Thread note');
    await expect(notes).toContainText('Literal <script>note</script>');
    expect(await notes.getByRole('listitem').count()).toBeLessThan(20);
    await notes.getByRole('button', { name: 'Load more notes', exact: true }).click();
    await expect(notes.getByRole('status')).toContainText('101 notes loaded');
    const noteList = notes.getByRole('list', { name: 'Notes', exact: true });
    await noteList.focus();
    await noteList.press('End');
    await expect(notes).toContainText('Last note');
    await app.evaluate(() => {
      (
        globalThis as typeof globalThis & { gitlabIssues: { updated: boolean } }
      ).gitlabIssues.updated = true;
    });
    await dialog.getByLabel('Automatic refresh', { exact: true }).selectOption('1');
    await page.clock.fastForward(60000);
    await expect(notes).toContainText('Refreshed last note');
    await expect(search).toHaveValue('Needle');
    expect(
      await app.evaluate(
        () =>
          (globalThis as typeof globalThis & { gitlabIssues: { notesPages: number[] } })
            .gitlabIssues.notesPages,
      ),
    ).toEqual([1, 2, 1, 2]);
    await app.evaluate(() => {
      (
        globalThis as typeof globalThis & { gitlabIssues: { visible: boolean } }
      ).gitlabIssues.visible = false;
    });
    await page.clock.fastForward(60000);
    await expect(detail).not.toContainText('Confidential issue');
    await expect(notes.getByRole('status')).toContainText('100 notes loaded');
    await dialog.getByLabel('Automatic refresh', { exact: true }).selectOption('0');
    await app.evaluate(() => {
      (
        globalThis as typeof globalThis & { gitlabIssues: { blocked: boolean } }
      ).gitlabIssues.blocked = true;
    });
    await notes.getByRole('button', { name: 'Refresh notes', exact: true }).click();
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (globalThis as typeof globalThis & { gitlabIssues: { started: boolean } }).gitlabIssues
              .started,
        ),
      )
      .toBe(true);
    await detail.getByRole('button', { name: 'Details', exact: true }).click();
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (globalThis as typeof globalThis & { gitlabIssues: { cancelled: boolean } })
              .gitlabIssues.cancelled,
        ),
      )
      .toBe(true);
    await expect(notes).toHaveCount(0);
    await dialog.getByLabel('Issue state', { exact: true }).selectOption('closed');
    await expect(list.getByRole('option')).toContainText('Closed');
    await list.focus();
    await list.press('Home');
    await list.press('Enter');
    await expect(detail).toContainText('#7 Issue 7');
    await expect(detail).toContainText('Closed');
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
