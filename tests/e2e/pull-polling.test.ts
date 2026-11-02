import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fixtureProtection } from './provider-fixtures.js';
import {
  githubPullFixture,
  githubCommentFixture,
} from '../../packages/test-fixtures/src/provider.js';

test('automatic PR refresh preserves loaded tabs, search, selection and drafts while guarding changed commits', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-pull-polling-'));
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    await fixtureProtection(app);
    await app.evaluate(
      ({ session }, fixtures) => {
        const fixture = fixtures.pull;
        const state = {
          version: 0,
          checksVersion: 0,
          filesVersion: 0,
          reviewsVersion: 0,
          commentsVersion: 0,
          head: '1'.repeat(40),
          pages: [] as number[],
          filePages: [] as number[],
        };
        Object.assign(globalThis, { pullPolling: state });
        const json = (body: unknown) =>
          new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
        const pull = (number: number) => ({
          ...fixture,
          number,
          title: `Pull ${number} v${state.version}`,
          body: `Description v${state.version}`,
          head: { ...fixture.head, sha: state.head },
        });
        session.fromPartition('openkraken-providers').fetch = async (input, init) => {
          const url = new URL(String(input));
          if (new Headers(init?.headers).get('authorization') !== 'token fixture-pat')
            throw new Error('Unexpected credential');
          if (url.pathname === '/user') return json({ id: 321, login: 'fixture-user' });
          if (url.pathname === '/user/repos')
            return json([
              { id: 1, name: 'project', owner: { login: 'team' }, private: false, archived: false },
            ]);
          if (url.pathname === '/repos/team/project/pulls') {
            const page = Number(url.searchParams.get('page'));
            state.pages.push(page);
            return json(
              page === 1
                ? state.version
                  ? [pull(999), ...Array.from({ length: 99 }, (_, i) => pull(i + 1))]
                  : Array.from({ length: 100 }, (_, i) => pull(i + 1))
                : state.version
                  ? [pull(100), pull(101)]
                  : [pull(101)],
            );
          }
          if (url.pathname === '/repos/team/project/pulls/1') return json(pull(1));
          if (url.pathname === '/repos/team/project/pulls/1/comments') {
            const comment = (id: number) => ({
              ...fixtures.comment,
              id,
              body: `Inline ${id} v${state.commentsVersion}`,
              line: state.head === '4'.repeat(40) ? null : fixtures.comment.line,
            });
            return json(
              url.searchParams.get('page') === '1'
                ? Array.from({ length: 100 }, (_, i) => comment(i + 1))
                : state.commentsVersion
                  ? [comment(101), comment(102)]
                  : [comment(101)],
            );
          }
          if (url.pathname === '/repos/team/project/pulls/1/reviews') {
            const review = (id: number) => ({
              id,
              user: { login: 'reviewer' },
              state: 'COMMENTED',
              body: `Review ${id} v${state.reviewsVersion}`,
              commit_id: state.head,
              submitted_at: '2026-10-02T00:00:00Z',
            });
            return json(
              url.searchParams.get('page') === '1'
                ? Array.from({ length: 100 }, (_, i) => review(i + 1))
                : state.reviewsVersion
                  ? [review(101), review(102)]
                  : [review(101)],
            );
          }
          if (url.pathname === '/repos/team/project/pulls/1/files') {
            const page = Number(url.searchParams.get('page'));
            state.filePages.push(page);
            const file = (i: number) => ({
              filename: `file-${i}.txt`,
              status: 'modified',
              additions: 1,
              deletions: 1,
              changes: 2,
              sha: '5'.repeat(40),
              patch: `@@ -1 +1 @@\n-old\n+File ${i} v${state.filesVersion}`,
            });
            return json(page === 1 ? Array.from({ length: 100 }, (_, i) => file(i)) : [file(100)]);
          }
          if (url.pathname === '/graphql') {
            const { variables } = JSON.parse(String(init?.body)) as {
              variables: { after: string | null };
            };
            if (variables.after !== null && variables.after !== `v${state.checksVersion}-next`)
              return json({ errors: [{ message: 'Obsolete cursor' }] });
            const check = (id: number) => ({
              __typename: 'CheckRun',
              id: `check-${id}`,
              name: `Check ${id} v${state.checksVersion}`,
              status: 'COMPLETED',
              conclusion: state.checksVersion ? 'SUCCESS' : 'FAILURE',
            });
            return json({
              data: {
                repository: {
                  pullRequest: {
                    headRefOid: state.head,
                    commits: {
                      nodes: [
                        {
                          commit: {
                            oid: state.head,
                            statusCheckRollup: {
                              state: state.checksVersion ? 'SUCCESS' : 'FAILURE',
                              contexts: {
                                totalCount: state.checksVersion ? 102 : 101,
                                nodes: variables.after
                                  ? state.checksVersion
                                    ? [check(101), check(102)]
                                    : [check(101)]
                                  : Array.from({ length: 100 }, (_, i) => check(i + 1)),
                                pageInfo: {
                                  hasNextPage: variables.after === null,
                                  endCursor:
                                    variables.after === null
                                      ? `v${state.checksVersion}-next`
                                      : null,
                                },
                              },
                            },
                          },
                        },
                      ],
                    },
                  },
                },
              },
            });
          }
          throw new Error('Unexpected endpoint');
        };
      },
      { pull: githubPullFixture(), comment: githubCommentFixture() },
    );
    const page = await app.firstWindow();
    await page.clock.install();
    await page.evaluate(() =>
      window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'providerConnect',
        options: { provider: 'github', origin: 'https://github.com', token: 'fixture-pat' },
      }),
    );
    await page.getByRole('button', { name: 'Pull requests', exact: true }).click();
    const browser = page.getByRole('dialog', { name: 'Browse pull requests' });
    await browser.getByRole('option', { name: 'Select team/project', exact: true }).click();
    await browser.getByRole('button', { name: 'Load more pull requests', exact: true }).click();
    await expect(
      browser.getByText('101 pull requests loaded · 101 match', { exact: true }),
    ).toBeVisible();
    const search = browser.getByRole('searchbox', { name: 'Search loaded pull requests' });
    await search.fill('Pull 1');
    const list = browser.getByRole('listbox', { name: 'Pull requests', exact: true });
    await list.focus();
    await list.press('Home');
    await list.press('Enter');
    await expect(browser.getByRole('heading', { name: '#1 Pull 1 v0', exact: true })).toBeVisible();
    await expect(browser.getByLabel('Automatic refresh', { exact: true })).toBeVisible();
    await browser.getByLabel('Automatic refresh', { exact: true }).selectOption('1');
    await app.evaluate(() => {
      (globalThis as typeof globalThis & { pullPolling: { version: number } }).pullPolling.version =
        1;
    });
    await page.clock.fastForward(60000);
    await expect(browser.getByRole('heading', { name: '#1 Pull 1 v1', exact: true })).toBeVisible();
    await expect(
      browser.getByText('102 pull requests loaded · 13 match', { exact: true }),
    ).toBeVisible();
    await expect(search).toHaveValue('Pull 1');
    await expect(list).toHaveAttribute('aria-activedescendant', /-1$/);
    expect(
      await app.evaluate(
        () =>
          (globalThis as typeof globalThis & { pullPolling: { pages: number[] } }).pullPolling
            .pages,
      ),
    ).toEqual([1, 2, 1, 2]);
    await browser.getByRole('button', { name: 'Checks', exact: true }).click();
    const checks = browser.getByRole('region', { name: 'Pull-request checks' });
    await checks.getByRole('button', { name: 'Load more checks', exact: true }).click();
    await expect(
      checks.getByText('101 loaded · 101 reported contexts', { exact: true }),
    ).toBeVisible();
    await app.evaluate(() => {
      (
        globalThis as typeof globalThis & { pullPolling: { checksVersion: number } }
      ).pullPolling.checksVersion = 1;
    });
    await page.clock.fastForward(60000);
    await expect(
      checks.getByText('102 loaded · 102 reported contexts', { exact: true }),
    ).toBeVisible();
    await expect(checks.getByText('Check 1 v1', { exact: true })).toBeVisible();
    await app.evaluate(() => {
      Object.assign((globalThis as typeof globalThis & { pullPolling: object }).pullPolling, {
        head: '2'.repeat(40),
        checksVersion: 2,
      });
    });
    await page.clock.fastForward(60000);
    await expect(checks).toContainText('2'.repeat(40));
    await expect(
      checks.getByText('100 loaded · 102 reported contexts', { exact: true }),
    ).toBeVisible();
    await expect(checks.getByText('Check 1 v2', { exact: true })).toBeVisible();
    await browser.getByRole('button', { name: 'Files', exact: true }).click();
    const files = browser.getByRole('region', { name: 'Pull-request files', exact: true });
    await files.getByRole('button', { name: 'Load more files', exact: true }).click();
    await expect(files.getByText('101 files loaded', { exact: true })).toBeVisible();
    const fileList = files.getByRole('listbox', { name: 'Changed files', exact: true });
    await fileList.focus();
    await fileList.press('End');
    await fileList.press('Enter');
    const patch = files.getByRole('region', { name: 'Selected file patch', exact: true });
    await expect(patch).toContainText('File 100 v0');
    await app.evaluate(() => {
      (
        globalThis as typeof globalThis & { pullPolling: { filesVersion: number } }
      ).pullPolling.filesVersion = 1;
    });
    await page.clock.fastForward(60000);
    await expect(patch).toContainText('File 100 v1');
    await expect(files.getByText('101 files loaded', { exact: true })).toBeVisible();
    expect(
      await app.evaluate(
        () =>
          (globalThis as typeof globalThis & { pullPolling: { filePages: number[] } }).pullPolling
            .filePages,
      ),
    ).toEqual([1, 2, 1, 2]);
    await app.evaluate(() => {
      Object.assign((globalThis as typeof globalThis & { pullPolling: object }).pullPolling, {
        head: '3'.repeat(40),
        filesVersion: 2,
      });
    });
    await page.clock.fastForward(60000);
    await expect(files.getByText('100 files loaded', { exact: true })).toBeVisible();
    await expect(patch).toHaveCount(0);
    await browser.getByRole('button', { name: 'Reviews', exact: true }).click();
    const reviews = browser.getByRole('region', { name: 'Pull-request reviews', exact: true });
    await reviews.getByRole('button', { name: 'Load more reviews', exact: true }).click();
    await expect(reviews.getByText('101 reviews loaded', { exact: true })).toBeVisible();
    await app.evaluate(() => {
      (
        globalThis as typeof globalThis & { pullPolling: { reviewsVersion: number } }
      ).pullPolling.reviewsVersion = 1;
    });
    await page.clock.fastForward(60000);
    await expect(reviews.getByText('102 reviews loaded', { exact: true })).toBeVisible();
    await expect(reviews.getByText('Review 1 v1', { exact: true })).toBeVisible();
    await app.evaluate(() => {
      Object.assign((globalThis as typeof globalThis & { pullPolling: object }).pullPolling, {
        head: 'a'.repeat(40),
        reviewsVersion: 2,
      });
    });
    await page.clock.fastForward(60000);
    await expect(reviews.getByText('102 reviews loaded', { exact: true })).toBeVisible();
    await expect(reviews.getByText('Review 1 v2', { exact: true })).toBeVisible();
    await browser.getByRole('button', { name: 'Comments', exact: true }).click();
    const comments = browser.getByRole('region', { name: 'Inline review comments', exact: true });
    await comments.getByRole('button', { name: 'Load more comments', exact: true }).click();
    await expect(comments.getByText('101 comments loaded', { exact: true })).toBeVisible();
    await comments.getByText('Comment diff context', { exact: true }).first().click();
    await app.evaluate(() => {
      (
        globalThis as typeof globalThis & { pullPolling: { commentsVersion: number } }
      ).pullPolling.commentsVersion = 1;
    });
    await page.clock.fastForward(60000);
    await expect(comments.getByText('102 comments loaded', { exact: true })).toBeVisible();
    await expect(comments.getByText('Inline 1 v1', { exact: true })).toBeVisible();
    await expect(comments.locator('details').first()).toHaveAttribute('open', '');
    await app.evaluate(() => {
      Object.assign((globalThis as typeof globalThis & { pullPolling: object }).pullPolling, {
        head: '4'.repeat(40),
        commentsVersion: 2,
      });
    });
    await page.clock.fastForward(60000);
    await expect(comments.getByText('102 comments loaded', { exact: true })).toBeVisible();
    await expect(comments.getByText('Inline 1 v2', { exact: true })).toBeVisible();
    await expect(comments).toContainText('Outdated');
    await expect(comments.locator('details').first()).toHaveAttribute('open', '');
    await comments.getByRole('button', { name: 'Reply to thread #1', exact: true }).click();
    const draft = page.getByRole('dialog', { name: 'Write inline comment', exact: true });
    await draft
      .getByRole('textbox', { name: 'Comment text', exact: true })
      .fill('Preserve my reply');
    const before = await app.evaluate(
      () =>
        (globalThis as typeof globalThis & { pullPolling: { pages: number[] } }).pullPolling.pages
          .length,
    );
    await page.clock.fastForward(180000);
    await expect(draft.getByRole('textbox', { name: 'Comment text', exact: true })).toHaveValue(
      'Preserve my reply',
    );
    expect(
      await app.evaluate(
        () =>
          (globalThis as typeof globalThis & { pullPolling: { pages: number[] } }).pullPolling.pages
            .length,
      ),
    ).toBe(before);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
