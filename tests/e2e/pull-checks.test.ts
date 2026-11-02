import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fixtureProtection } from './provider-fixtures.js';
import { githubPullFixture } from '../../packages/test-fixtures/src/provider.js';

test('PR checks page both context types, refresh changed results, reject stale heads and cancel hidden requests', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-pr-checks-ui-'));
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    await fixtureProtection(app);
    await app.evaluate(({ session }, fixture) => {
      const state = {
        head: '1'.repeat(40),
        fail: true,
        pass: false,
        many: false,
        empty: false,
        cycle: false,
        blocked: false,
        started: false,
        cancelled: false,
        reads: 0,
      };
      Object.assign(globalThis, { checksFixture: state });
      const json = (value: unknown) =>
        new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
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
        const pull = { ...fixture, head: { ...fixture.head, sha: state.head } };
        if (url.pathname === '/repos/team/project/pulls') return json([pull]);
        if (url.pathname === '/repos/team/project/pulls/1') return json(pull);
        if (url.pathname === '/graphql' && init?.method === 'POST') {
          state.reads++;
          if (state.blocked) {
            state.started = true;
            await new Promise<void>((resolve) => {
              if (init.signal?.aborted) resolve();
              else init.signal?.addEventListener('abort', () => resolve(), { once: true });
            });
            state.cancelled = true;
            throw new DOMException('Cancelled', 'AbortError');
          }
          if (state.fail) return json({ errors: [{ message: 'fixture-pat' }], data: null });
          const body = JSON.parse(String(init.body)) as { variables: { after: string | null } };
          const check = {
            __typename: 'CheckRun',
            id: 'check-1',
            name: '<img src=x onerror=alert(1)> Tests',
            status: 'COMPLETED',
            conclusion: state.pass ? 'SUCCESS' : 'FAILURE',
          };
          const pageNumber = body.variables.after ? Number(body.variables.after.split('-')[1]) : 0;
          const nodes = state.many
            ? Array.from({ length: 100 }, (_, index) => ({
                ...check,
                id: `check-${pageNumber * 100 + index}`,
                name: `Check ${pageNumber * 100 + index}`,
              }))
            : body.variables.after
              ? [
                  { ...check, conclusion: 'SUCCESS' },
                  {
                    __typename: 'StatusContext',
                    id: 'status-1',
                    context: 'deploy',
                    state: 'PENDING',
                    description: 'Waiting for deployment',
                  },
                ]
              : [check];
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
                          statusCheckRollup: state.empty
                            ? null
                            : {
                                state: state.pass ? 'SUCCESS' : 'PENDING',
                                contexts: {
                                  totalCount: state.many ? 1500 : 2,
                                  nodes,
                                  pageInfo: {
                                    hasNextPage:
                                      state.many ||
                                      state.cycle ||
                                      (!body.variables.after && !state.pass),
                                    endCursor: state.many
                                      ? `page-${pageNumber + 1}`
                                      : state.cycle && body.variables.after === 'next'
                                        ? 'other'
                                        : 'next',
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
    }, githubPullFixture());
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
    await page.getByRole('button', { name: 'Pull requests', exact: true }).click();
    const browser = page.getByRole('dialog', { name: 'Browse pull requests' });
    await browser.getByRole('option', { name: 'Select team/project', exact: true }).click();
    await browser
      .getByRole('listbox', { name: 'Pull requests', exact: true })
      .getByRole('option')
      .click();
    const details = browser.getByRole('region', { name: 'Pull-request details' });
    await details.getByRole('button', { name: 'Checks', exact: true }).click();
    const checks = details.getByRole('region', { name: 'Pull-request checks' });
    await expect(checks.getByRole('alert')).toContainText('Check results could not be read');
    await expect(checks).not.toContainText('fixture-pat');
    await app.evaluate(() => {
      (globalThis as typeof globalThis & { checksFixture: { fail: boolean } }).checksFixture.fail =
        false;
    });
    await checks.getByRole('button', { name: 'Refresh checks' }).click();
    await expect(checks).toContainText('Provider rollup: PENDING');
    await expect(checks.getByRole('listitem')).toHaveCount(1);
    await expect(checks.getByRole('listitem')).toContainText('FAILURE');
    await expect(checks.locator('img')).toHaveCount(0);
    await checks.getByRole('button', { name: 'Load more checks' }).click();
    await expect(checks.getByRole('listitem')).toHaveCount(2);
    await expect(checks.getByRole('listitem').first()).toContainText('SUCCESS');
    await expect(checks.getByRole('listitem').last()).toContainText('Waiting for deployment');
    await checks.getByRole('button', { name: 'Refresh checks' }).click();
    await expect(checks.getByRole('listitem')).toHaveCount(1);
    await app.evaluate(() => {
      (
        globalThis as typeof globalThis & { checksFixture: { empty: boolean } }
      ).checksFixture.empty = true;
    });
    await checks.getByRole('button', { name: 'Load more checks' }).click();
    await expect(checks).toContainText('No check results reported');
    await expect(checks.getByRole('listitem')).toHaveCount(0);
    await app.evaluate(() => {
      Object.assign(
        (globalThis as typeof globalThis & { checksFixture: { empty: boolean; cycle: boolean } })
          .checksFixture,
        { empty: false, cycle: true },
      );
    });
    await checks.getByRole('button', { name: 'Refresh checks' }).click();
    await expect(checks.getByRole('listitem')).toHaveCount(1);
    await checks.getByRole('button', { name: 'Load more checks' }).click();
    await expect(checks.getByRole('listitem')).toHaveCount(2);
    await checks.getByRole('button', { name: 'Load more checks' }).click();
    await expect(checks.getByRole('alert')).toContainText('repeated a check page');
    await expect(checks.getByRole('listitem')).toHaveCount(0);
    await app.evaluate(() => {
      (
        globalThis as typeof globalThis & { checksFixture: { cycle: boolean } }
      ).checksFixture.cycle = false;
    });

    await app.evaluate(() => {
      (globalThis as typeof globalThis & { checksFixture: { pass: boolean } }).checksFixture.pass =
        true;
    });
    await checks.getByRole('button', { name: 'Refresh checks' }).click();
    await expect(checks).toContainText('Provider rollup: SUCCESS');
    await expect(checks.getByRole('listitem')).toHaveCount(1);
    await app.evaluate(() => {
      (globalThis as typeof globalThis & { checksFixture: { head: string } }).checksFixture.head =
        '2'.repeat(40);
    });
    await checks.getByRole('button', { name: 'Refresh checks' }).click();
    await expect(checks.getByRole('alert')).toContainText('head changed');
    await expect(checks.getByRole('listitem')).toHaveCount(0);
    await expect(checks).not.toContainText('Provider rollup: SUCCESS');
    await details.getByRole('button', { name: 'Refresh details' }).click();
    await expect(checks).toContainText('Provider rollup: SUCCESS');
    await expect(checks).toContainText('2'.repeat(40));
    await page.screenshot({ path: 'test-results/provider-pr-checks.png' });
    await app.evaluate(() => {
      (globalThis as typeof globalThis & { checksFixture: { many: boolean } }).checksFixture.many =
        true;
    });
    await checks.getByRole('button', { name: 'Refresh checks' }).click();
    await expect(checks).toContainText('100 loaded');
    for (let pageNumber = 2; pageNumber <= 10; pageNumber++) {
      await checks.getByRole('button', { name: 'Load more checks' }).click();
      await expect(checks).toContainText(`${pageNumber * 100} loaded`);
    }
    await expect(checks.getByRole('button', { name: 'Load more checks' })).toHaveCount(0);
    await expect(checks).toContainText('1,000-context display limit');
    expect(await checks.getByRole('listitem').count()).toBeLessThan(25);
    const results = checks.getByRole('list', { name: 'Check results' });
    await results.focus();
    await results.press('Control+End');
    await expect(checks.getByRole('listitem').filter({ hasText: 'Check 999' })).toBeVisible();

    await app.evaluate(() => {
      (
        globalThis as typeof globalThis & { checksFixture: { blocked: boolean } }
      ).checksFixture.blocked = true;
    });
    await checks.getByRole('button', { name: 'Refresh checks' }).click();
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (globalThis as typeof globalThis & { checksFixture: { started: boolean } })
              .checksFixture.started,
        ),
      )
      .toBe(true);
    await details.getByRole('button', { name: 'Details', exact: true }).click();
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (globalThis as typeof globalThis & { checksFixture: { cancelled: boolean } })
              .checksFixture.cancelled,
        ),
      )
      .toBe(true);
    await expect(checks).toHaveCount(0);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
