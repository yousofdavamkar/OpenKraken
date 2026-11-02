import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fixtureProtection } from './provider-fixtures.js';
import { githubIssueFixture } from '../../packages/test-fixtures/src/provider.js';

test('issue actions review drafts, refuse stale changes, confirm writes and inspect uncertain results without retries', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-issue-actions-ui-'));
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    await fixtureProtection(app);
    await app.evaluate(({ session }, fixture) => {
      const issues: (Omit<typeof fixture, 'state_reason'> & {
        state_reason: string | null;
        url: string;
      })[] = [{ ...fixture, url: 'https://api.github.com/repos/team/project/issues/1' }];
      const comments: {
        id: number;
        user: null;
        body: string;
        created_at: string;
        updated_at: string;
        issue_url: string;
      }[] = [];
      const state = {
        mode: 'ok',
        writes: [] as unknown[],
        block: false,
        started: false,
        issues,
        comments,
      };
      Object.assign(globalThis, { issueActionsFixture: state });
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
        const match = /^\/repos\/team\/project\/issues(?:\/(\d+))?(\/comments)?$/.exec(
          url.pathname,
        );
        if (!match) throw new Error('Unexpected endpoint');
        const number = Number(match[1]),
          issue = issues.find((item) => item.number === number);
        if (init?.method === 'POST' || init?.method === 'PATCH') {
          const body = JSON.parse(String(init.body)) as {
            title?: string;
            body?: string;
            state?: string;
            state_reason?: string;
          };
          state.writes.push({ method: init.method, path: url.pathname, body });
          if (state.mode === 'reject') return json({ message: 'fixture-pat' }, 422);
          let result;
          if (!match[1]) {
            result = {
              ...fixture,
              number: issues.length + 1,
              title: body.title!,
              body: body.body!,
              comments: 0,
              url: `https://api.github.com/repos/team/project/issues/${issues.length + 1}`,
            };
            issues.push(result);
          } else if (match[2]) {
            result = {
              id: comments.length + 10,
              user: null,
              body: body.body!,
              created_at: '2026-10-04T00:00:00Z',
              updated_at: '2026-10-04T00:00:00Z',
              issue_url: issue!.url,
            };
            comments.push(result);
            issue!.comments++;
          } else {
            issue!.state = body.state!;
            issue!.state_reason = body.state_reason!;
            result = issue;
          }
          return state.mode === 'uncertain'
            ? json({ message: 'fixture-pat' }, 500)
            : json(result, init.method === 'POST' ? 201 : 200);
        }
        if (!match[1])
          return json(
            issues.filter(
              (item) =>
                url.searchParams.get('state') === 'all' ||
                item.state === url.searchParams.get('state'),
            ),
          );
        if (match[2]) return json(comments.filter((comment) => comment.issue_url === issue!.url));
        if (state.block) {
          state.started = true;
          await new Promise<void>((resolve) => {
            if (init?.signal?.aborted) resolve();
            else init?.signal?.addEventListener('abort', () => resolve(), { once: true });
          });
          throw new DOMException('Cancelled', 'AbortError');
        }
        return json(issue);
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
    const modal = page.getByRole('dialog', { name: 'Issue action', exact: true });
    const writes = () =>
      app.evaluate(
        () =>
          (globalThis as typeof globalThis & { issueActionsFixture: { writes: unknown[] } })
            .issueActionsFixture.writes,
      );
    const mode = async (value: string) =>
      app.evaluate((_electron, value) => {
        (
          globalThis as typeof globalThis & { issueActionsFixture: { mode: string } }
        ).issueActionsFixture.mode = value;
      }, value);
    await browser.getByRole('button', { name: 'New issue', exact: true }).click();
    await modal.getByRole('textbox', { name: 'Issue title' }).fill('Created issue');
    await modal.getByRole('textbox', { name: 'Description' }).fill('Reviewed description');
    await modal.getByRole('button', { name: 'Review issue action' }).click();
    expect(await writes()).toHaveLength(0);
    await expect(modal.getByRole('region', { name: 'Confirm issue action' })).toContainText(
      'Created issue',
    );
    await modal.getByRole('button', { name: 'Confirm issue action' }).click();
    await expect(modal.getByRole('status')).toContainText('Created issue #2');
    await modal.getByRole('button', { name: 'Close action' }).click();
    await expect(browser).toContainText('2 issues loaded');
    await browser.getByRole('option', { name: 'Open issue #1: A bug to fix', exact: true }).click();
    const detail = browser.getByRole('region', { name: 'Issue details' });
    await detail.getByRole('button', { name: 'Write issue comment' }).click();
    await modal.getByRole('textbox', { name: 'Comment' }).fill('Keep my comment');
    await modal.getByRole('button', { name: 'Review issue action' }).click();
    await app.evaluate(() => {
      (
        globalThis as typeof globalThis & { issueActionsFixture: { issues: { body: string }[] } }
      ).issueActionsFixture.issues[0]!.body = 'Changed within the same timestamp';
    });
    await modal.getByRole('button', { name: 'Confirm issue action' }).click();
    await expect(modal.getByRole('alert')).toContainText('issue changed');
    expect(await writes()).toHaveLength(1);
    await expect(modal.getByRole('textbox', { name: 'Comment' })).toHaveValue('Keep my comment');
    await modal.getByRole('button', { name: 'Close action' }).click();
    await modal.getByRole('button', { name: 'Keep draft' }).click();
    await modal.getByRole('button', { name: 'Review issue action' }).click();
    await mode('reject');
    await modal.getByRole('button', { name: 'Confirm issue action' }).click();
    await expect(modal.getByRole('alert')).toContainText('rejected');
    await expect(modal).not.toContainText('fixture-pat');
    await mode('ok');
    await modal.getByRole('button', { name: 'Review issue action' }).click();
    await modal.getByRole('button', { name: 'Confirm issue action' }).click();
    await expect(modal.getByRole('status')).toContainText('Posted comment #10');
    await modal.getByRole('button', { name: 'Close action' }).click();
    await detail.getByRole('button', { name: 'Comments', exact: true }).click();
    await expect(detail).toContainText('Keep my comment');
    await detail.getByRole('button', { name: 'Close issue', exact: true }).click();
    await modal.getByRole('combobox', { name: 'Closing reason' }).selectOption('not_planned');
    await modal.getByRole('button', { name: 'Review issue action' }).click();
    expect(await writes()).toHaveLength(3);
    await modal.getByRole('button', { name: 'Confirm issue action' }).click();
    await expect(modal.getByRole('status')).toContainText('Issue #1 is now closed');
    await modal.getByRole('button', { name: 'Close action' }).click();
    await expect(browser).toContainText('1 issue loaded');
    await browser.getByRole('combobox', { name: 'Issue state' }).selectOption('closed');
    await browser.getByRole('option', { name: 'Open issue #1: A bug to fix', exact: true }).click();
    await detail.getByRole('button', { name: 'Reopen issue' }).click();
    await modal.getByRole('button', { name: 'Review issue action' }).click();
    await mode('uncertain');
    await modal.getByRole('button', { name: 'Confirm issue action' }).click();
    await expect(modal.getByRole('alert')).toContainText('may have completed');
    await modal.getByRole('button', { name: 'Check existing results' }).click();
    await expect(modal).toContainText('Provider now reports: open');
    await expect(modal.getByRole('button', { name: 'I checked; review again' })).toHaveCount(0);
    expect(await writes()).toHaveLength(5);
    await modal.getByRole('button', { name: 'Close action' }).click();
    await browser.getByRole('combobox', { name: 'Issue state' }).selectOption('open');
    await browser.getByRole('button', { name: 'New issue', exact: true }).click();
    await modal.getByRole('textbox', { name: 'Issue title' }).fill('Possibly created');
    await modal.getByRole('button', { name: 'Review issue action' }).click();
    await modal.getByRole('button', { name: 'Confirm issue action' }).click();
    await modal.getByRole('button', { name: 'Check existing results' }).click();
    await expect(modal.getByRole('region', { name: 'Existing results' })).toContainText(
      'Possibly created',
    );
    expect(await writes()).toHaveLength(6);
    await modal.getByRole('button', { name: 'Close action' }).click();
    await modal.getByRole('button', { name: 'Discard draft' }).click();
    await browser.getByRole('option', { name: 'Open issue #1: A bug to fix', exact: true }).click();
    await detail.getByRole('button', { name: 'Write issue comment' }).click();
    await modal.getByRole('textbox', { name: 'Comment' }).fill('Possibly posted');
    await modal.getByRole('button', { name: 'Review issue action' }).click();
    await modal.getByRole('button', { name: 'Confirm issue action' }).click();
    await modal.getByRole('button', { name: 'Check existing results' }).click();
    await expect(modal.getByRole('region', { name: 'Existing results' })).toContainText(
      'Possibly posted',
    );
    expect(await writes()).toHaveLength(7);
    await modal
      .getByRole('region', { name: 'Existing results' })
      .locator('details')
      .last()
      .locator('summary')
      .click();
    await expect(
      modal
        .getByRole('region', { name: 'Existing results' })
        .getByText('Possibly posted', { exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: 'test-results/provider-issue-actions.png' });
    await modal.getByRole('button', { name: 'I checked; review again' }).click();
    await expect(modal.getByRole('textbox', { name: 'Comment' })).toHaveValue('Possibly posted');
    await modal.getByRole('button', { name: 'Review issue action' }).click();
    expect(await writes()).toHaveLength(7);

    await modal.getByRole('button', { name: 'Close action' }).click();
    await modal.getByRole('button', { name: 'Discard draft' }).click();
    await mode('ok');
    await detail.getByRole('button', { name: 'Close issue', exact: true }).click();
    await app.evaluate(() => {
      (
        globalThis as typeof globalThis & { issueActionsFixture: { block: boolean } }
      ).issueActionsFixture.block = true;
    });
    await modal.getByRole('button', { name: 'Review issue action' }).click();
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (globalThis as typeof globalThis & { issueActionsFixture: { started: boolean } })
              .issueActionsFixture.started,
        ),
      )
      .toBe(true);
    await expect(modal.getByRole('button', { name: 'Close action' })).toBeDisabled();
    await modal.getByRole('button', { name: 'Cancel request' }).click();
    await expect(modal.getByRole('alert')).toContainText('cancelled');
    expect(await writes()).toHaveLength(7);
    await modal.getByRole('button', { name: 'Close action' }).click();
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
