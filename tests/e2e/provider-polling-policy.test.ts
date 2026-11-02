import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fixtureProtection } from './provider-fixtures.js';
import { githubIssueFixture } from '../../packages/test-fixtures/src/provider.js';

test('provider revalidation and cooldowns cross the real desktop bridge without leaking credentials', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-polling-policy-ui-'));
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    await fixtureProtection(app);
    await app.evaluate(({ session }, issue) => {
      const state = {
        now: Date.parse('2026-11-01T00:00:00Z'),
        limited: false,
        requests: 0,
        validators: [] as (string | null)[],
      };
      Object.assign(globalThis, { pollingPolicyFixture: state });
      Date.now = () => state.now;
      const json = (body: unknown, headers: Record<string, string> = {}, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json', ...headers },
        });
      session.fromPartition('openkraken-providers').fetch = async (input, init) => {
        const url = new URL(String(input));
        const headers = new Headers(init?.headers);
        if (
          url.origin !== 'https://api.github.com' ||
          headers.get('authorization') !== 'token fixture-pat'
        )
          throw new Error('Unexpected provider');
        state.requests++;
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
          state.validators.push(headers.get('if-none-match'));
          if (state.limited)
            return json({ message: 'fixture-pat must not appear' }, { 'retry-after': '120' }, 429);
          if (headers.has('if-none-match'))
            return new Response(null, { status: 304, headers: { 'x-poll-interval': '90' } });
          return json([issue], { etag: '"issues"', 'x-poll-interval': '90' });
        }
        throw new Error('Unexpected endpoint');
      };
    }, githubIssueFixture());
    const page = await app.firstWindow();
    const connected = await page.evaluate(() =>
      window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'providerConnect',
        options: { provider: 'github', origin: 'https://github.com', token: 'fixture-pat' },
      }),
    );
    if (connected.kind !== 'providerAccounts') throw new Error('Account connection failed');
    const accountId = connected.state.accounts[0]!.id;
    const policy = () =>
      page.evaluate(
        (accountId) =>
          window.openkraken.request({
            id: crypto.randomUUID(),
            method: 'providerPollingPolicy',
            accountId,
          }),
        accountId,
      );
    await page.getByRole('button', { name: 'Issues', exact: true }).click();
    const browser = page.getByRole('dialog', { name: 'Browse issues' });
    await browser.getByRole('option', { name: 'Select team/project', exact: true }).click();
    await expect(
      browser.getByRole('option', { name: 'Open issue #1: A bug to fix', exact: true }),
    ).toBeVisible();
    expect(await policy()).toEqual({
      kind: 'providerPollingPolicy',
      policy: { minimumIntervalMs: 90000, blockedUntil: null },
    });
    await browser.getByRole('button', { name: 'Refresh issues', exact: true }).click();
    await expect(
      browser.getByRole('option', { name: 'Open issue #1: A bug to fix', exact: true }),
    ).toBeVisible();
    expect(
      await app.evaluate(
        () =>
          (
            globalThis as typeof globalThis & {
              pollingPolicyFixture: { validators: (string | null)[] };
            }
          ).pollingPolicyFixture.validators,
      ),
    ).toEqual([null, '"issues"']);
    await app.evaluate(() => {
      (
        globalThis as typeof globalThis & { pollingPolicyFixture: { limited: boolean } }
      ).pollingPolicyFixture.limited = true;
    });
    await browser.getByRole('button', { name: 'Refresh issues', exact: true }).click();
    await expect(browser.getByRole('alert')).toContainText('rate limit');
    await expect(browser).not.toContainText('fixture-pat');
    expect(await policy()).toEqual({
      kind: 'providerPollingPolicy',
      policy: { minimumIntervalMs: 90000, blockedUntil: 1793491320000 },
    });
    const before = await app.evaluate(
      () =>
        (globalThis as typeof globalThis & { pollingPolicyFixture: { requests: number } })
          .pollingPolicyFixture.requests,
    );
    const blocked = await page.evaluate(
      (accountId) =>
        window.openkraken.request({
          id: crypto.randomUUID(),
          method: 'providerIssues',
          accountId,
          options: { repository: { owner: 'team', name: 'project' }, state: 'open', page: 1 },
        }),
      accountId,
    );
    expect(blocked).toMatchObject({
      kind: 'error',
      code: 'PROVIDER_RATE_LIMIT',
      retryAt: 1793491320000,
    });
    expect(JSON.stringify(blocked)).not.toContain('fixture-pat');
    expect(
      await app.evaluate(
        () =>
          (globalThis as typeof globalThis & { pollingPolicyFixture: { requests: number } })
            .pollingPolicyFixture.requests,
      ),
    ).toBe(before);
    await app.evaluate(() => {
      const state = (
        globalThis as typeof globalThis & {
          pollingPolicyFixture: { limited: boolean; now: number };
        }
      ).pollingPolicyFixture;
      state.limited = false;
      state.now += 120000;
    });
    await browser.getByRole('button', { name: 'Retry issues', exact: true }).click();
    await expect(
      browser.getByRole('option', { name: 'Open issue #1: A bug to fix', exact: true }),
    ).toBeVisible();
    expect(await policy()).toEqual({
      kind: 'providerPollingPolicy',
      policy: { minimumIntervalMs: 90000, blockedUntil: null },
    });
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
