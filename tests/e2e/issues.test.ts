import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fixtureProtection } from './provider-fixtures.js';
import { githubIssueFixture } from '../../packages/test-fixtures/src/provider.js';

test('issue browsing preserves paging through PR-only pages, searches, opens comments and cancels obsolete reads', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-issues-ui-'));
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    await fixtureProtection(app);
    await app.evaluate(({ session }, fixture) => {
      const state = {
        fail: true,
        detailFail: true,
        block: '',
        started: false,
        cancelled: false,
        many: false,
      };
      Object.assign(globalThis, { issuesFixture: state });
      const json = (value: unknown, status = 200) =>
        new Response(JSON.stringify(value), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      session.fromPartition('openkraken-providers').fetch = async (input, init) => {
        const url = new URL(String(input));
        if (
          url.origin !== 'https://api.github.com' ||
          new Headers(init?.headers).get('authorization') !== 'token fixture-pat'
        )
          throw new Error('Unexpected provider');
        if (state.block && url.pathname.endsWith(state.block)) {
          state.started = true;
          await new Promise<void>((resolve) => {
            if (init?.signal?.aborted) resolve();
            else init?.signal?.addEventListener('abort', () => resolve(), { once: true });
          });
          state.cancelled = true;
          throw new DOMException('Cancelled', 'AbortError');
        }
        if (url.pathname === '/user') return json({ id: 321, login: 'fixture-user' });
        if (url.pathname === '/user/repos')
          return json([
            {
              id: 1,
              name: 'project',
              owner: { login: 'team' },
              description: '',
              private: false,
              archived: false,
            },
          ]);
        if (url.pathname === '/repos/team/project/issues') {
          if (state.fail) return json({ message: 'fixture-pat' }, 403);
          if (url.searchParams.get('state') === 'closed')
            return json([
              {
                ...fixture,
                number: 300,
                title: 'Resolved issue',
                state: 'closed',
                state_reason: 'completed',
              },
            ]);
          if (url.searchParams.get('page') === '1')
            return json(
              Array.from({ length: 100 }, (_, i) => ({
                ...fixture,
                number: i + 1,
                pull_request: {},
              })),
            );
          if (url.searchParams.get('page') === '2')
            return json(
              Array.from({ length: 100 }, (_, i) => ({
                ...fixture,
                number: i + 101,
                title: `Issue ${i + 101}`,
              })),
            );
          return json([
            { ...fixture, number: 200, title: 'Updated issue 200' },
            { ...fixture, number: 201, title: 'Last issue' },
          ]);
        }
        const details = /^\/repos\/team\/project\/issues\/(\d+)$/.exec(url.pathname);
        if (details) {
          if (state.detailFail) return json({ message: 'fixture-pat' }, 500);
          const number = Number(details[1]);
          return json({
            ...fixture,
            number,
            title: `Issue ${number}`,
            body: '<img src=x onerror=alert(1)> literal issue',
            state: number === 300 ? 'closed' : 'open',
            state_reason: number === 300 ? 'completed' : null,
          });
        }
        if (/\/issues\/\d+\/comments$/.test(url.pathname)) {
          const comment = {
            id: 1,
            user: null,
            body: '<script>literal comment</script>',
            created_at: '2026-10-01T00:00:00Z',
            updated_at: '2026-10-02T00:00:00Z',
            issue_url: `https://api.github.com${url.pathname.replace('/comments', '')}`,
          };
          if (state.many) {
            const start = (Number(url.searchParams.get('page')) - 1) * 100;
            return json(
              Array.from({ length: 100 }, (_, i) => ({
                ...comment,
                id: start + i + 1,
                body: `Comment ${start + i + 1}`,
              })),
            );
          }
          return json(
            url.searchParams.get('page') === '1'
              ? Array.from({ length: 100 }, (_, i) => ({ ...comment, id: i + 1 }))
              : [
                  { ...comment, id: 100, body: 'Updated comment' },
                  { ...comment, id: 101, body: 'Last comment' },
                ],
          );
        }
        throw new Error('Unexpected endpoint');
      };
    }, githubIssueFixture());
    const page = await app.firstWindow();
    expect(
      (
        await page.evaluate(() =>
          window.openkraken.request({
            id: crypto.randomUUID(),
            method: 'providerConnect',
            options: { provider: 'github', origin: 'https://github.com', token: 'fixture-pat' },
          }),
        )
      ).kind,
    ).toBe('providerAccounts');
    await page.getByRole('button', { name: 'Issues', exact: true }).click();
    const browser = page.getByRole('dialog', { name: 'Browse issues' });
    await browser.getByRole('option', { name: 'Select team/project', exact: true }).click();
    await expect(browser.getByRole('alert')).toContainText('denied access');
    await expect(browser).not.toContainText('fixture-pat');
    await app.evaluate(() => {
      (globalThis as typeof globalThis & { issuesFixture: { fail: boolean } }).issuesFixture.fail =
        false;
    });
    await browser.getByRole('button', { name: 'Retry issues' }).click();
    await expect(browser).toContainText('0 issues loaded');
    await expect(browser.getByRole('button', { name: 'Load more issues' })).toBeEnabled();
    await browser.getByRole('button', { name: 'Load more issues' }).click();
    await expect(browser).toContainText('100 issues loaded');
    const list = browser.getByRole('listbox', { name: 'Issues', exact: true });
    expect(await list.getByRole('option').count()).toBeLessThan(30);
    await browser.getByRole('button', { name: 'Load more issues' }).click();
    await expect(browser).toContainText('101 issues loaded');
    await browser.getByRole('searchbox', { name: 'Search loaded issues' }).fill('Updated issue');
    await expect(list.getByRole('option')).toHaveCount(1);
    await list.focus();
    await list.press('Enter');
    const detail = browser.getByRole('region', { name: 'Issue details' });
    await expect(detail.getByRole('alert')).toBeVisible();
    await app.evaluate(() => {
      (
        globalThis as typeof globalThis & { issuesFixture: { detailFail: boolean } }
      ).issuesFixture.detailFail = false;
    });
    await detail.getByRole('button', { name: 'Retry issue' }).click();
    await expect(detail.getByRole('heading', { name: '#200 Issue 200' })).toBeVisible();
    await expect(detail).toContainText('Next release');
    await expect(detail).toContainText('maintainer');
    await expect(detail).toContainText('<img src=x onerror=alert(1)> literal issue');
    await expect(detail.locator('img')).toHaveCount(0);
    await detail.getByRole('button', { name: 'Comments', exact: true }).click();
    const comments = detail.getByRole('region', { name: 'Issue comments' });
    await expect(comments).toContainText('100 comments loaded');
    await expect(comments).toContainText('<script>literal comment</script>');
    expect(await comments.getByRole('listitem').count()).toBeLessThan(25);
    await comments.getByRole('button', { name: 'Load more comments' }).click();
    await expect(comments).toContainText('101 comments loaded');
    const discussion = comments.getByRole('list', { name: 'Comments' });
    await discussion.focus();
    await discussion.press('End');
    await expect(comments.getByText('Last comment', { exact: true })).toBeVisible();
    await page.screenshot({ path: 'test-results/provider-issues.png' });
    await app.evaluate(() => {
      (globalThis as typeof globalThis & { issuesFixture: { many: boolean } }).issuesFixture.many =
        true;
    });
    await comments.getByRole('button', { name: 'Refresh comments' }).click();
    await expect(comments).toContainText('100 comments loaded');
    for (let pageNumber = 2; pageNumber <= 10; pageNumber++) {
      await comments.getByRole('button', { name: 'Load more comments' }).click();
      await expect(comments).toContainText(`${pageNumber * 100} comments loaded`);
    }
    await expect(comments.getByRole('button', { name: 'Load more comments' })).toHaveCount(0);
    await expect(comments).toContainText('comment display limit was reached');
    expect(await comments.getByRole('listitem').count()).toBeLessThan(25);
    await discussion.focus();
    await discussion.press('End');
    await expect(comments.getByText('Comment 1000', { exact: true })).toBeVisible();

    await app.evaluate(() => {
      (globalThis as typeof globalThis & { issuesFixture: { block: string } }).issuesFixture.block =
        '/comments';
    });
    await comments.getByRole('button', { name: 'Refresh comments' }).click();
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (globalThis as typeof globalThis & { issuesFixture: { started: boolean } })
              .issuesFixture.started,
        ),
      )
      .toBe(true);
    await browser.getByRole('combobox', { name: 'Issue state' }).selectOption('closed');
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (globalThis as typeof globalThis & { issuesFixture: { cancelled: boolean } })
              .issuesFixture.cancelled,
        ),
      )
      .toBe(true);
    await expect(browser).toContainText('1 issue loaded');
    await list.focus();
    await list.press('End');
    await list.press('Enter');
    await expect(detail).toContainText('completed');
    await app.evaluate(() => {
      Object.assign(
        (
          globalThis as typeof globalThis & {
            issuesFixture: { block: string; started: boolean; cancelled: boolean };
          }
        ).issuesFixture,
        { block: '/issues', started: false, cancelled: false },
      );
    });
    await browser.getByRole('button', { name: 'Refresh issues' }).click();
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (globalThis as typeof globalThis & { issuesFixture: { started: boolean } })
              .issuesFixture.started,
        ),
      )
      .toBe(true);
    await browser.getByRole('button', { name: 'Choose repository' }).click();
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (globalThis as typeof globalThis & { issuesFixture: { cancelled: boolean } })
              .issuesFixture.cancelled,
        ),
      )
      .toBe(true);
    await expect(
      browser.getByRole('option', { name: 'Select team/project', exact: true }),
    ).toBeVisible();
    await browser.getByRole('button', { name: 'Close', exact: true }).click();
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
