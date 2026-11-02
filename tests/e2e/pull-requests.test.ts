import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fixtureProtection } from './provider-fixtures.js';

test('PR browsing pages, filters, retries details and cancels obsolete repository requests', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-pr-ui-'));
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    await fixtureProtection(app);
    await app.evaluate(({ session }) => {
      Object.assign(globalThis, {
        prDetailFailed: false,
        prBlocked: false,
        prStarted: false,
        prAborted: false,
      });
      session.fromPartition('openkraken-providers').fetch = async (input, init) => {
        const url = new URL(String(input));
        if (
          url.origin !== 'https://api.github.com' ||
          new Headers(init?.headers).get('authorization') !== 'token fixture-pat' ||
          init?.redirect !== 'error' ||
          init.credentials !== 'omit'
        )
          throw new Error('Unexpected provider request');
        const json = (value: unknown, status = 200) =>
          new Response(JSON.stringify(value), {
            status,
            headers: { 'content-type': 'application/json' },
          });
        if (url.pathname === '/user') return json({ id: 321, login: 'fixture-user' });
        if (url.pathname === '/user/repos')
          return json(
            ['project', 'other'].map((name, index) => ({
              id: index + 1,
              name,
              owner: { login: 'team' },
              description: name,
              private: false,
              archived: false,
            })),
          );
        const flags = globalThis as typeof globalThis & {
          prDetailFailed: boolean;
          prBlocked: boolean;
          prStarted: boolean;
          prAborted: boolean;
        };
        const pr = (number: number, closed = false) => ({
          number,
          title: number === 101 ? 'Needle PR' : `Fixture PR ${number}`,
          state: closed ? 'closed' : 'open',
          draft: number === 1,
          user: { login: 'contributor' },
          created_at: '2026-10-01T00:00:00Z',
          updated_at: '2026-10-02T00:00:00Z',
          merged_at: closed ? '2026-10-02T00:00:00Z' : null,
          html_url: 'https://attacker.test/ignore',
          body: '<img src="https://attacker.test/pixel" onerror="window.prInjected=true">\nPR description',
          head: { label: 'fork:feature', ref: 'feature', sha: '1'.repeat(40) },
          base: { label: 'team:main', ref: 'main', sha: '2'.repeat(40) },
          merged: closed,
          mergeable: null,
          mergeable_state: 'unknown',
          commits: 2,
          comments: 3,
          review_comments: 1,
          changed_files: 4,
          additions: 12,
          deletions: 3,
        });
        if (url.pathname === '/repos/team/project/pulls') {
          if (flags.prBlocked) {
            flags.prStarted = true;
            await new Promise<void>((resolve) => {
              if (init?.signal?.aborted) resolve();
              else init?.signal?.addEventListener('abort', () => resolve(), { once: true });
            });
            flags.prAborted = true;
            return json([{ ...pr(999), title: 'Obsolete response' }]);
          }
          if (url.searchParams.get('state') === 'closed') return json([pr(201, true)]);
          return json(
            url.searchParams.get('page') === '1'
              ? Array.from({ length: 100 }, (_, i) => pr(i + 1))
              : [pr(100), pr(101)],
          );
        }
        if (url.pathname === '/repos/team/project/pulls/101') {
          if (!flags.prDetailFailed) {
            flags.prDetailFailed = true;
            return json({ message: 'Do not expose fixture-pat' }, 503);
          }
          return json(pr(101));
        }
        if (url.pathname === '/repos/team/other/pulls')
          return json([{ ...pr(301), title: 'Other repository PR' }]);
        if (url.pathname === '/repos/team/other/pulls/301') {
          flags.prStarted = true;
          flags.prAborted = false;
          await new Promise<void>((resolve) => {
            if (init?.signal?.aborted) resolve();
            else init?.signal?.addEventListener('abort', () => resolve(), { once: true });
          });
          flags.prAborted = true;
          return json(pr(301));
        }
        throw new Error('Unexpected PR endpoint');
      };
    });
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
    const dialog = page.getByRole('dialog', { name: 'Browse pull requests' });
    await dialog.getByRole('option', { name: 'Select team/project', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('100 pull requests loaded');
    const list = dialog.getByRole('listbox', { name: 'Pull requests', exact: true });
    expect(await list.getByRole('option').count()).toBeLessThan(20);
    await dialog.getByRole('button', { name: 'Load more pull requests' }).click();
    await expect(dialog.getByRole('status')).toContainText('101 pull requests loaded');
    await dialog.getByRole('searchbox', { name: 'Search loaded pull requests' }).fill('Needle');
    await expect(list.getByRole('option')).toHaveCount(1);
    await list.focus();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    const details = dialog.getByRole('region', { name: 'Pull-request details' });
    await expect(details.getByRole('alert')).toContainText('provider request failed');
    await expect(dialog).not.toContainText('fixture-pat');
    await details.getByRole('button', { name: 'Retry details' }).click();
    await expect(details.getByRole('heading')).toHaveText('#101 Needle PR');
    await expect(details).toContainText('fork:feature → team:main');
    await expect(details).toContainText('https://github.com/team/project/pull/101');
    await expect(details.locator('.pull-body')).toContainText('<img src=');
    await expect(details.locator('img')).toHaveCount(0);
    expect(
      await page.evaluate(() => (window as typeof window & { prInjected?: boolean }).prInjected),
    ).toBeUndefined();
    await page.screenshot({ path: 'test-results/provider-pull-request-details.png' });
    await dialog
      .getByRole('combobox', { name: 'Pull-request state', exact: true })
      .selectOption('closed');
    await expect(dialog.getByRole('status')).toContainText('1 pull request loaded');
    await expect(list.getByRole('option')).toContainText('Merged');
    await expect(details).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Refresh pull requests', exact: true }).click();
    await expect(list.getByRole('option')).toContainText('#201');
    await app.evaluate(() =>
      Object.assign(globalThis, { prBlocked: true, prStarted: false, prAborted: false }),
    );
    await dialog
      .getByRole('combobox', { name: 'Pull-request state', exact: true })
      .selectOption('all');
    await expect
      .poll(() =>
        app.evaluate(() => (globalThis as typeof globalThis & { prStarted: boolean }).prStarted),
      )
      .toBe(true);
    await dialog.getByRole('button', { name: 'Choose repository' }).click();
    await expect
      .poll(() =>
        app.evaluate(() => (globalThis as typeof globalThis & { prAborted: boolean }).prAborted),
      )
      .toBe(true);
    await dialog.getByRole('option', { name: 'Select team/other', exact: true }).click();
    await expect(list.getByRole('option')).toContainText('Other repository PR');
    await expect(dialog).not.toContainText('Obsolete response');
    await app.evaluate(() => Object.assign(globalThis, { prStarted: false }));
    await list.getByRole('option').click();
    await expect
      .poll(() =>
        app.evaluate(() => (globalThis as typeof globalThis & { prStarted: boolean }).prStarted),
      )
      .toBe(true);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect
      .poll(() =>
        app.evaluate(() => (globalThis as typeof globalThis & { prAborted: boolean }).prAborted),
      )
      .toBe(true);
    await expect(dialog).toHaveCount(0);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
