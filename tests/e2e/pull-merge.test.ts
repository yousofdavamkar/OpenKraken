import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fixtureProtection } from './provider-fixtures.js';
import { githubPullFixture } from '../../packages/test-fixtures/src/provider.js';

test('PR merge rechecks tips and methods, confirms once, and checks an uncertain result without another write', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-pr-merge-ui-'));
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    await fixtureProtection(app);
    await app.evaluate(({ session }, fixture) => {
      const state = {
        number: 1,
        head: '1'.repeat(40),
        squash: true,
        merged: false,
        mode: 'ok',
        writes: [] as unknown[],
        blocked: false,
        started: false,
      };
      Object.assign(globalThis, { mergeFixture: state });
      const json = (value: unknown, status = 200) =>
        new Response(JSON.stringify(value), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      const pull = () => ({
        ...fixture,
        number: state.number,
        head: { ...fixture.head, sha: state.head },
        state: state.merged ? 'closed' : 'open',
        merged: state.merged,
        merged_at: state.merged ? '2026-10-03T00:00:00Z' : null,
      });
      session.fromPartition('openkraken-providers').fetch = async (input, init) => {
        const url = new URL(String(input));
        if (
          url.origin !== 'https://api.github.com' ||
          new Headers(init?.headers).get('authorization') !== 'token fixture-pat'
        )
          throw new Error('Unexpected provider request');
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
        if (url.pathname === '/repos/team/project') {
          if (state.blocked) {
            state.started = true;
            await new Promise<void>((resolve) => {
              if (init?.signal?.aborted) resolve();
              else init?.signal?.addEventListener('abort', () => resolve(), { once: true });
            });
            throw new DOMException('Cancelled', 'AbortError');
          }
          return json({
            archived: false,
            allow_merge_commit: true,
            allow_squash_merge: state.squash,
            allow_rebase_merge: false,
            permissions: { push: true },
          });
        }
        if (url.pathname === '/repos/team/project/pulls')
          return json(state.merged && url.searchParams.get('state') === 'open' ? [] : [pull()]);
        if (url.pathname === `/repos/team/project/pulls/${state.number}`) return json(pull());
        if (
          url.pathname === `/repos/team/project/pulls/${state.number}/merge` &&
          init?.method === 'PUT'
        ) {
          state.writes.push(JSON.parse(String(init.body)));
          if (state.mode === 'reject') return json({ message: 'fixture-pat' }, 409);
          state.merged = true;
          return state.mode === 'uncertain'
            ? json({ message: 'fixture-pat' }, 500)
            : json({ merged: true, sha: '4'.repeat(40), message: 'Merged' });
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
    const list = browser.getByRole('listbox', { name: 'Pull requests', exact: true });
    await list.getByRole('option').click();
    const details = browser.getByRole('region', { name: 'Pull-request details' });
    await details.getByRole('button', { name: 'Review PR merge' }).click();
    const merge = page.getByRole('dialog', { name: 'Merge pull request', exact: true });
    await expect(merge.getByRole('combobox', { name: 'Merge method' })).toHaveValue('merge');
    await expect(merge.getByRole('option')).toHaveCount(2);
    await merge.getByRole('combobox', { name: 'Merge method' }).selectOption('squash');
    await merge.getByLabel('Use provider default commit message').uncheck();
    await merge
      .getByRole('textbox', { name: 'Merge commit title', exact: true })
      .fill('Reviewed merge');
    await merge
      .getByRole('textbox', { name: 'Merge commit message', exact: true })
      .fill('Keep this message across re-review.');
    await merge.getByRole('button', { name: 'Review selected merge' }).click();
    await expect(merge.getByRole('region', { name: 'Confirm remote PR merge' })).toContainText(
      'Squash and merge #1 into team:main',
    );
    const writes = () =>
      app.evaluate(
        () =>
          (globalThis as typeof globalThis & { mergeFixture: { writes: unknown[] } }).mergeFixture
            .writes,
      );
    expect(await writes()).toEqual([]);
    await app.evaluate(() => {
      (globalThis as typeof globalThis & { mergeFixture: { head: string } }).mergeFixture.head =
        '3'.repeat(40);
    });
    await merge.getByRole('button', { name: 'Merge confirmed PR' }).click();
    await expect(merge.getByRole('alert')).toContainText('commits or branches changed');
    expect(await writes()).toEqual([]);
    await expect(
      merge.getByRole('textbox', { name: 'Merge commit message', exact: true }),
    ).toHaveValue('Keep this message across re-review.');
    await expect(merge.getByRole('button', { name: 'Review selected merge' })).toBeDisabled();
    await merge.getByRole('button', { name: 'Refresh merge preview' }).click();
    await merge.getByRole('button', { name: 'Review selected merge' }).click();
    await app.evaluate(() => {
      (
        globalThis as typeof globalThis & { mergeFixture: { squash: boolean } }
      ).mergeFixture.squash = false;
    });
    await merge.getByRole('button', { name: 'Merge confirmed PR' }).click();
    await expect(merge.getByRole('alert')).toContainText('method is no longer available');
    expect(await writes()).toEqual([]);
    await merge.getByRole('button', { name: 'Refresh merge preview' }).click();
    await expect(merge.getByRole('combobox', { name: 'Merge method' })).toHaveValue('merge');
    await app.evaluate(() => {
      (globalThis as typeof globalThis & { mergeFixture: { mode: string } }).mergeFixture.mode =
        'reject';
    });
    await merge.getByRole('button', { name: 'Review selected merge' }).click();
    await merge.getByRole('button', { name: 'Merge confirmed PR' }).click();
    await expect(merge.getByRole('alert')).toContainText('provider rejected');
    await expect(merge).not.toContainText('fixture-pat');
    expect(await writes()).toHaveLength(1);
    await merge.getByRole('button', { name: 'Close merge' }).click();
    await expect(merge.getByRole('region', { name: 'Discard merge message' })).toBeVisible();
    await merge.getByRole('button', { name: 'Keep editing' }).click();
    await app.evaluate(() => {
      (globalThis as typeof globalThis & { mergeFixture: { mode: string } }).mergeFixture.mode =
        'ok';
    });
    await merge.getByRole('button', { name: 'Refresh merge preview' }).click();
    await merge.getByRole('button', { name: 'Review selected merge' }).click();
    await merge.getByRole('button', { name: 'Merge confirmed PR' }).click();
    await expect(merge.getByRole('status')).toContainText(
      `Merged. Resulting commit: ${'4'.repeat(40)}`,
    );
    expect((await writes())[1]).toEqual({
      sha: '3'.repeat(40),
      merge_method: 'merge',
      commit_title: 'Reviewed merge',
      commit_message: 'Keep this message across re-review.',
    });
    await page.screenshot({ path: 'test-results/provider-pr-merged.png' });
    await merge.getByRole('button', { name: 'Close merge' }).click();
    await expect(browser.getByRole('status')).toContainText('0 pull requests loaded');
    await app.evaluate(() =>
      Object.assign((globalThis as typeof globalThis & { mergeFixture: object }).mergeFixture, {
        number: 2,
        merged: false,
        mode: 'uncertain',
      }),
    );
    await browser.getByRole('button', { name: 'Refresh pull requests', exact: true }).click();
    await list.getByRole('option').click();
    await details.getByRole('button', { name: 'Review PR merge' }).click();
    await merge.getByRole('button', { name: 'Review selected merge' }).click();
    await merge.getByRole('button', { name: 'Merge confirmed PR' }).click();
    await expect(merge.getByRole('alert')).toContainText('may have merged');
    expect(await writes()).toHaveLength(3);
    await expect(merge.getByRole('button', { name: 'Merge confirmed PR' })).toHaveCount(0);
    await merge.getByRole('button', { name: 'Check merge status' }).click();
    await expect(merge.getByRole('status')).toContainText('provider now reports this PR as merged');
    await expect(
      merge.getByRole('button', { name: 'I checked; load a fresh merge preview' }),
    ).toHaveCount(0);
    expect(await writes()).toHaveLength(3);
    await merge.getByRole('button', { name: 'Close merge' }).click();
    await expect(browser.getByRole('status')).toContainText('0 pull requests loaded');
    await app.evaluate(() =>
      Object.assign((globalThis as typeof globalThis & { mergeFixture: object }).mergeFixture, {
        number: 3,
        merged: false,
        mode: 'ok',
      }),
    );
    await browser.getByRole('button', { name: 'Refresh pull requests', exact: true }).click();
    await list.getByRole('option').click();
    await expect(details.getByRole('button', { name: 'Review PR merge' })).toBeEnabled();
    await app.evaluate(() => {
      (
        globalThis as typeof globalThis & { mergeFixture: { blocked: boolean } }
      ).mergeFixture.blocked = true;
    });
    await details.getByRole('button', { name: 'Review PR merge' }).click();
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (globalThis as typeof globalThis & { mergeFixture: { started: boolean } }).mergeFixture
              .started,
        ),
      )
      .toBe(true);
    await expect(merge.getByRole('button', { name: 'Close merge' })).toBeDisabled();
    await merge.getByRole('button', { name: 'Cancel request' }).click();
    await expect(merge.getByRole('alert')).toContainText('cancelled');
    expect(await writes()).toHaveLength(3);
    await app.evaluate(() => {
      (
        globalThis as typeof globalThis & { mergeFixture: { blocked: boolean } }
      ).mergeFixture.blocked = false;
    });
    await merge.getByRole('button', { name: 'Close merge' }).click();
    await browser.getByRole('button', { name: 'Close', exact: true }).click();
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
