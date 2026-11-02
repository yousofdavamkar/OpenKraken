import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fixtureProtection } from './provider-fixtures.js';
import { githubIssueFixture } from '../../packages/test-fixtures/src/provider.js';

test('automatic issue refresh preserves loaded pages, keyboard selection and details and pauses for a draft', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-polling-ui-'));
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    await fixtureProtection(app);
    await app.evaluate(({ session }, fixture) => {
      const state = { changed: false, commentsChanged: false, pages: [] as number[], details: 0 };
      Object.assign(globalThis, { pollingFixture: state });
      const json = (data: unknown) =>
        new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
      const issue = (number: number) => ({
        ...fixture,
        number,
        title: `Issue ${number}${state.changed ? ' updated' : ''}`,
        body: state.changed ? 'Updated description' : 'Original description',
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
        if (url.pathname === '/repos/team/project/issues') {
          const page = Number(url.searchParams.get('page'));
          state.pages.push(page);
          return json(
            page === 1
              ? state.changed
                ? [issue(999), ...Array.from({ length: 99 }, (_, i) => issue(i + 1))]
                : Array.from({ length: 100 }, (_, i) => issue(i + 1))
              : state.changed
                ? [issue(100), issue(101)]
                : [issue(101)],
          );
        }
        if (url.pathname === '/repos/team/project/issues/101') {
          state.details++;
          return json(issue(101));
        }
        if (url.pathname === '/repos/team/project/issues/101/comments') {
          const page = Number(url.searchParams.get('page'));
          const comment = (id: number) => ({
            id,
            user: { login: 'reader' },
            body: `Comment ${id}${state.commentsChanged ? ' updated' : ''}`,
            created_at: '2026-10-01T00:00:00Z',
            updated_at: '2026-10-02T00:00:00Z',
            issue_url: 'https://api.github.com/repos/team/project/issues/101',
          });
          return json(
            page === 1
              ? Array.from({ length: 100 }, (_, i) => comment(i + 1))
              : state.commentsChanged
                ? [comment(101), comment(102)]
                : [comment(101)],
          );
        }
        throw new Error('Unexpected endpoint');
      };
    }, githubIssueFixture());
    const page = await app.firstWindow();
    await page.clock.install();
    await page.evaluate(() =>
      window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'providerConnect',
        options: { provider: 'github', origin: 'https://github.com', token: 'fixture-pat' },
      }),
    );
    await page.getByRole('button', { name: 'Issues', exact: true }).click();
    const browser = page.getByRole('dialog', { name: 'Browse issues' });
    await browser.getByRole('option', { name: 'Select team/project', exact: true }).click();
    await browser.getByRole('button', { name: 'Load more issues', exact: true }).click();
    await expect(browser.getByText('101 issues loaded · 101 match', { exact: true })).toBeVisible();
    const list = browser.getByRole('listbox', { name: 'Issues', exact: true });
    await list.focus();
    await list.press('End');
    await list.press('Enter');
    await expect(
      browser.getByRole('heading', { name: '#101 Issue 101', exact: true }),
    ).toBeVisible();
    await browser.getByLabel('Automatic refresh', { exact: true }).selectOption('1');
    await app.evaluate(() => {
      (
        globalThis as typeof globalThis & { pollingFixture: { changed: boolean } }
      ).pollingFixture.changed = true;
    });
    await page.clock.fastForward(60000);
    await expect(
      browser.getByRole('heading', { name: '#101 Issue 101 updated', exact: true }),
    ).toBeVisible();
    await expect(browser.getByText('102 issues loaded · 102 match', { exact: true })).toBeVisible();
    await expect(list).toHaveAttribute('aria-activedescendant', /-101$/);
    expect(
      await app.evaluate(
        () =>
          (globalThis as typeof globalThis & { pollingFixture: { pages: number[] } }).pollingFixture
            .pages,
      ),
    ).toEqual([1, 2, 1, 2]);
    await browser.getByRole('button', { name: 'Comments', exact: true }).click();
    const comments = browser.getByRole('region', { name: 'Issue comments', exact: true });
    await comments.getByRole('button', { name: 'Load more comments', exact: true }).click();
    await expect(comments.getByText('101 comments loaded', { exact: true })).toBeVisible();
    await app.evaluate(() => {
      (
        globalThis as typeof globalThis & { pollingFixture: { commentsChanged: boolean } }
      ).pollingFixture.commentsChanged = true;
    });
    await page.clock.fastForward(60000);
    await expect(comments.getByText('102 comments loaded', { exact: true })).toBeVisible();
    await expect(comments.getByText('Comment 1 updated', { exact: true })).toBeVisible();
    await browser.getByRole('button', { name: 'Write issue comment', exact: true }).click();
    const action = page.getByRole('dialog', { name: 'Issue action', exact: true });
    await action.getByRole('textbox', { name: 'Comment', exact: true }).fill('Keep this draft');
    const before = await app.evaluate(
      () =>
        (globalThis as typeof globalThis & { pollingFixture: { pages: number[] } }).pollingFixture
          .pages.length,
    );
    await page.clock.fastForward(180000);
    await expect(action.getByRole('textbox', { name: 'Comment', exact: true })).toHaveValue(
      'Keep this draft',
    );
    expect(
      await app.evaluate(
        () =>
          (globalThis as typeof globalThis & { pollingFixture: { pages: number[] } }).pollingFixture
            .pages.length,
      ),
    ).toBe(before);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('scheduled refresh honors provider intervals, keeps complete pages on failure and cancels obsolete reads', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-polling-control-'));
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    await fixtureProtection(app);
    await app.evaluate(({ session }, fixture) => {
      const state = {
        now: Date.parse('2026-11-01T00:00:00Z'),
        changed: false,
        fail: false,
        blocked: false,
        started: false,
        cancelled: false,
        pages: [] as number[],
      };
      Object.assign(globalThis, { pollingControl: state });
      Date.now = () => state.now;
      const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
        new Response(JSON.stringify(data), {
          status,
          headers: { 'content-type': 'application/json', ...headers },
        });
      session.fromPartition('openkraken-providers').fetch = async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === '/user') return json({ id: 321, login: 'fixture-user' });
        if (url.pathname === '/user/repos')
          return json([
            { id: 1, name: 'project', owner: { login: 'team' }, private: false, archived: false },
          ]);
        if (url.pathname !== '/repos/team/project/issues') throw new Error('Unexpected endpoint');
        const page = Number(url.searchParams.get('page'));
        state.pages.push(page);
        if (state.blocked) {
          state.started = true;
          await new Promise<void>((resolve) => {
            if (init?.signal?.aborted) resolve();
            else init?.signal?.addEventListener('abort', () => resolve(), { once: true });
          });
          state.cancelled = true;
          throw new DOMException('Cancelled', 'AbortError');
        }
        if (state.fail && page === 2)
          return json({ message: 'fixture-pat' }, 503, { 'retry-after': '180' });
        const item = (number: number) => ({
          ...fixture,
          number,
          title: `Issue ${number}${state.changed ? ' changed' : ''}`,
        });
        return json(
          page === 1 ? Array.from({ length: 100 }, (_, i) => item(i + 1)) : [item(101)],
          200,
          { 'x-poll-interval': '120' },
        );
      };
    }, githubIssueFixture());
    const page = await app.firstWindow();
    await page.clock.install({ time: new Date('2026-11-01T00:00:00Z') });
    const advance = async (ms: number) => {
      await app.evaluate((ms) => {
        (
          globalThis as typeof globalThis & { pollingControl: { now: number } }
        ).pollingControl.now += ms;
      }, ms);
      await page.clock.fastForward(ms);
    };
    const pages = () =>
      app.evaluate(
        () =>
          (globalThis as typeof globalThis & { pollingControl: { pages: number[] } }).pollingControl
            .pages,
      );
    await page.evaluate(() =>
      window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'providerConnect',
        options: { provider: 'github', origin: 'https://github.com', token: 'fixture-pat' },
      }),
    );
    await page.getByRole('button', { name: 'Issues', exact: true }).click();
    const browser = page.getByRole('dialog', { name: 'Browse issues' });
    await browser.getByRole('option', { name: 'Select team/project', exact: true }).click();
    await browser.getByRole('button', { name: 'Load more issues', exact: true }).click();
    await expect(browser.getByText('101 issues loaded · 101 match', { exact: true })).toBeVisible();
    await browser.getByLabel('Automatic refresh', { exact: true }).selectOption('1');
    await advance(60000);
    await expect(browser.getByRole('status', { name: 'Automatic refresh status' })).toContainText(
      'allowed by the provider',
    );
    expect(await pages()).toEqual([1, 2]);
    await app.evaluate(() => {
      Object.assign((globalThis as typeof globalThis & { pollingControl: object }).pollingControl, {
        changed: true,
        fail: true,
      });
    });
    await advance(60000);
    await expect(browser.getByRole('status', { name: 'Automatic refresh status' })).toContainText(
      'Automatic refresh failed',
    );
    await expect(
      browser.getByRole('option', { name: 'Open issue #1: Issue 1', exact: true }),
    ).toBeVisible();
    await expect(browser.getByText('101 issues loaded · 101 match', { exact: true })).toBeVisible();
    expect(await pages()).toEqual([1, 2, 1, 2]);
    await app.evaluate(() => {
      (
        globalThis as typeof globalThis & { pollingControl: { fail: boolean } }
      ).pollingControl.fail = false;
    });
    await advance(120000);
    expect(await pages()).toEqual([1, 2, 1, 2]);
    await advance(60000);
    await expect(
      browser.getByRole('option', { name: 'Open issue #1: Issue 1 changed', exact: true }),
    ).toBeVisible();
    await app.evaluate(() => {
      (
        globalThis as typeof globalThis & { pollingControl: { blocked: boolean } }
      ).pollingControl.blocked = true;
    });
    await advance(120000);
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (globalThis as typeof globalThis & { pollingControl: { started: boolean } })
              .pollingControl.started,
        ),
      )
      .toBe(true);
    await browser.getByLabel('Automatic refresh', { exact: true }).selectOption('0');
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (globalThis as typeof globalThis & { pollingControl: { cancelled: boolean } })
              .pollingControl.cancelled,
        ),
      )
      .toBe(true);
    const count = (await pages()).length;
    await advance(600000);
    expect((await pages()).length).toBe(count);
    await browser.getByRole('button', { name: 'Close', exact: true }).click();
    await app.evaluate(() => {
      (
        globalThis as typeof globalThis & { pollingControl: { blocked: boolean } }
      ).pollingControl.blocked = false;
    });
    await page.getByRole('button', { name: 'Issues', exact: true }).click();
    await browser.getByRole('option', { name: 'Select team/project', exact: true }).click();
    await expect(browser.getByLabel('Automatic refresh', { exact: true })).toHaveValue('0');
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
