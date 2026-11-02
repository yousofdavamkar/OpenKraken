import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fixtureProtection } from './provider-fixtures.js';
import { bitbucketPullFixture, bitbucketCommentFixture } from '../bitbucket-fixtures.js';

test('Bitbucket comments page, search, navigate parents and retain historical locations across source refreshes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-bitbucket-comments-ui-'));
  const app = await electron.launch({ args: [resolve('apps/desktop'), `--user-data-dir=${root}`] });
  try {
    await fixtureProtection(app);
    await app.evaluate(
      ({ session }, fixtures) => {
        Object.assign(globalThis, {
          bcChanged: false,
          bcFail: false,
          bcBlock: false,
          bcStarted: false,
          bcAborted: false,
          bcPages: [] as number[],
        });
        session.fromPartition('openkraken-providers').fetch = async (input, init) => {
          const url = new URL(String(input));
          if (
            url.origin !== 'https://api.bitbucket.org' ||
            new Headers(init?.headers).get('authorization') !== 'Bearer comments-secret' ||
            init?.redirect !== 'error' ||
            init.credentials !== 'omit'
          )
            throw new Error('Unexpected request');
          const flags = globalThis as typeof globalThis & {
            bcChanged: boolean;
            bcFail: boolean;
            bcBlock: boolean;
            bcStarted: boolean;
            bcAborted: boolean;
            bcPages: number[];
          };
          const workspace = { uuid: '{40000000-0000-4000-8000-000000000001}', slug: 'team' };
          const pull = {
            ...fixtures.pull,
            source: {
              ...fixtures.pull.source,
              commit: { hash: (flags.bcChanged ? '3' : '1').repeat(40) },
            },
          };
          if (url.pathname === '/2.0/user') return Response.json(pull.author);
          if (url.pathname === '/2.0/user/workspaces')
            return Response.json({ values: [{ workspace }] });
          if (url.pathname === '/2.0/repositories/team')
            return Response.json({
              values: [{ ...pull.destination.repository, workspace, scm: 'git', is_private: true }],
            });
          if (url.pathname === '/2.0/repositories/team/project')
            return Response.json(pull.destination.repository);
          if (url.pathname === '/2.0/repositories/team/project/pullrequests')
            return Response.json({ values: [pull] });
          if (url.pathname === '/2.0/repositories/team/project/pullrequests/1')
            return Response.json(pull);
          if (url.pathname === '/2.0/repositories/team/project/pullrequests/1/comments') {
            if (flags.bcBlock) {
              flags.bcStarted = true;
              await new Promise<void>((resolve) => {
                if (init.signal?.aborted) resolve();
                else init.signal?.addEventListener('abort', () => resolve(), { once: true });
              });
              flags.bcAborted = true;
            }
            if (flags.bcFail) return Response.json({ message: 'comments-secret' }, { status: 503 });
            const page = Number(url.searchParams.get('page'));
            flags.bcPages.push(page);
            if (
              url.searchParams.get('pagelen') !== '100' ||
              url.searchParams.get('sort') !== 'created_on'
            )
              throw new Error('Unexpected comment query');
            const comment = (id: number) => ({
              ...fixtures.comment,
              id,
              content: {
                raw:
                  id === 101
                    ? flags.bcChanged
                      ? 'Needle updated reply'
                      : 'Needle <script>literal reply</script>'
                    : `Comment ${id}`,
              },
              parent: id === 101 ? { id: 1 } : id === 102 ? { id: 999 } : null,
              deleted: id === 102,
              pending: id === 101 && !flags.bcChanged,
              inline:
                id === 1 ? { path: 'src/old.ts', from: 8, start_from: 5, outdated: true } : null,
              resolution:
                id === 1
                  ? {
                      type: 'comment_resolution',
                      user: pull.author,
                      created_on: '2026-10-02T12:00:00+00:00',
                    }
                  : null,
            });
            return Response.json({
              page,
              values:
                page === 1
                  ? Array.from({ length: 100 }, (_, i) => comment(i + 1))
                  : [comment(100), comment(101), comment(102)],
              ...(page === 1
                ? {
                    next: 'https://api.bitbucket.org/2.0/repositories/team/project/pullrequests/1/comments?page=2',
                  }
                : {}),
            });
          }
          throw new Error('Unexpected endpoint');
        };
      },
      { pull: bitbucketPullFixture(), comment: bitbucketCommentFixture() },
    );
    const page = await app.firstWindow();
    await page.clock.install();
    expect(
      (
        await page.evaluate(() =>
          window.openkraken.request({
            id: crypto.randomUUID(),
            method: 'providerConnect',
            options: {
              provider: 'bitbucket',
              origin: 'https://bitbucket.org',
              token: 'comments-secret',
            },
          }),
        )
      ).kind,
    ).toBe('providerAccounts');
    await page.getByRole('button', { name: 'Pull requests', exact: true }).click();
    await page.getByRole('option', { name: 'Select workspace team', exact: true }).click();
    await page.getByRole('option', { name: 'Select team/project', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Browse pull requests' });
    await dialog.getByRole('option', { name: 'Open pull request #1: Pull 1', exact: true }).click();
    const details = dialog.getByRole('region', { name: 'Bitbucket pull-request details' });
    await details.getByRole('button', { name: 'Show comments', exact: true }).click();
    const comments = details.getByRole('region', { name: 'Bitbucket comments', exact: true });
    await expect(comments.getByRole('status')).toHaveText('100 comments loaded.');
    const list = comments.getByRole('listbox', { name: 'Comments', exact: true });
    expect(await list.getByRole('option').count()).toBeLessThan(20);
    await list.focus();
    await list.press('End');
    await expect(
      list.getByRole('option', { name: 'Open comment #100', exact: true }),
    ).toHaveAttribute('aria-selected', 'true');
    await comments.getByRole('button', { name: 'Load more comments' }).click();
    await expect(comments.getByRole('status')).toHaveText('102 comments loaded.');
    await comments.getByLabel('Search loaded comments').fill('Needle');
    await list.focus();
    await list.press('Enter');
    const selected = comments.getByRole('region', { name: 'Selected comment' });
    await expect(selected).toContainText('Needle <script>literal reply</script>');
    await expect(selected).toContainText('Pending publication');
    await expect(selected.locator('script')).toHaveCount(0);
    await selected.getByRole('button', { name: 'Show parent comment #1', exact: true }).click();
    await expect(selected).toContainText('Old lines 5–8');
    await expect(selected).toContainText('Outdated location');
    await expect(selected).toContainText('Resolved');
    await expect(comments.getByLabel('Search loaded comments')).toHaveValue('');
    await comments.getByLabel('Search loaded comments').fill('Needle');
    await list.focus();
    await list.press('Enter');
    await app.evaluate(() => Object.assign(globalThis, { bcChanged: true }));
    await dialog.getByLabel('Automatic refresh', { exact: true }).selectOption('1');
    await page.clock.fastForward(60000);
    await expect(dialog.getByRole('status', { name: 'Automatic refresh status' })).toContainText(
      'Automatic refresh completed.',
    );
    await expect(selected).toContainText('Needle updated reply');
    await expect(comments.getByLabel('Search loaded comments')).toHaveValue('Needle');
    await expect(list.getByRole('option')).toHaveAttribute('aria-selected', 'true');
    expect(
      await app.evaluate(() => (globalThis as typeof globalThis & { bcPages: number[] }).bcPages),
    ).toEqual([1, 2, 1, 2]);
    await dialog.getByLabel('Automatic refresh', { exact: true }).selectOption('0');
    await comments.getByLabel('Search loaded comments').fill('#102');
    await list.focus();
    await list.press('Enter');
    await expect(selected).toContainText('Comment deleted.');
    await expect(selected).toContainText('Parent comment #999 is not loaded.');
    await expect(selected).not.toContainText('Comment 102');
    await app.evaluate(() => Object.assign(globalThis, { bcFail: true }));
    await comments.getByRole('button', { name: 'Refresh comments', exact: true }).click();
    await expect(comments.getByRole('alert')).toBeVisible();
    await expect(selected).toHaveCount(0);
    await expect(dialog).not.toContainText('comments-secret');
    await app.evaluate(() => Object.assign(globalThis, { bcFail: false }));
    await comments.getByRole('button', { name: 'Retry comments', exact: true }).click();
    await expect(comments.getByRole('status')).toHaveText('100 comments loaded.');
    await app.evaluate(() => Object.assign(globalThis, { bcBlock: true }));
    await comments.getByRole('button', { name: 'Refresh comments', exact: true }).click();
    await expect
      .poll(() =>
        app.evaluate(() => (globalThis as typeof globalThis & { bcStarted: boolean }).bcStarted),
      )
      .toBe(true);
    await details.getByRole('button', { name: 'Hide comments', exact: true }).click();
    await expect
      .poll(() =>
        app.evaluate(() => (globalThis as typeof globalThis & { bcAborted: boolean }).bcAborted),
      )
      .toBe(true);
    await expect(comments).toHaveCount(0);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
