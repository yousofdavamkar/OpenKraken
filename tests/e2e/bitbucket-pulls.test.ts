import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fixtureProtection } from './provider-fixtures.js';
import { bitbucketPullFixture } from '../bitbucket-fixtures.js';

test('Bitbucket pull requests page, search, preserve native details and refresh without losing selection', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-bitbucket-pulls-ui-'));
  const app = await electron.launch({ args: [resolve('apps/desktop'), `--user-data-dir=${root}`] });
  try {
    await fixtureProtection(app);
    await app.evaluate(({ session }, fixture) => {
      Object.assign(globalThis, {
        bbDeleted: false,
        bbDiffFail: false,
        bbPages: [] as number[],
        bbFail: false,
        bbBlock: false,
        bbStarted: false,
        bbAborted: false,
      });
      session.fromPartition('openkraken-providers').fetch = async (input, init) => {
        const url = new URL(String(input));
        if (
          url.origin !== 'https://api.bitbucket.org' ||
          new Headers(init?.headers).get('authorization') !== 'Bearer pull-secret' ||
          init?.redirect !==
            (/\/pullrequests\/101\/(diff|diffstat)$/.test(url.pathname) ? 'manual' : 'error') ||
          init.credentials !== 'omit'
        )
          throw new Error('Unexpected request');
        const flags = globalThis as typeof globalThis & {
          bbDeleted: boolean;
          bbDiffFail: boolean;
          bbPages: number[];
          bbFail: boolean;
          bbBlock: boolean;
          bbStarted: boolean;
          bbAborted: boolean;
        };
        const workspace = { uuid: '{40000000-0000-4000-8000-000000000001}', slug: 'team' };
        if (url.pathname === '/2.0/user') return Response.json(fixture.author);
        if (url.pathname === '/2.0/user/workspaces')
          return Response.json({ values: [{ workspace }] });
        if (url.pathname === '/2.0/repositories/team')
          return Response.json({
            values: [
              {
                ...fixture.destination.repository,
                workspace,
                scm: 'git',
                is_private: true,
                description: '',
              },
            ],
          });
        if (url.pathname === '/2.0/repositories/team/project')
          return Response.json(fixture.destination.repository);
        const pull = (id: number, state = 'OPEN') => ({
          ...fixture,
          id,
          title: id === 101 ? 'Needle pull' : `Pull ${id}`,
          state,
        });
        if (url.pathname === '/2.0/repositories/team/project/pullrequests') {
          const number = Number(url.searchParams.get('page'));
          flags.bbPages.push(number);
          const states = url.searchParams.getAll('state');
          if (states.length > 1)
            return Response.json({ values: states.map((state, i) => pull(201 + i, state)) });
          if (states[0] !== 'OPEN') return Response.json({ values: [pull(201, states[0])] });
          return Response.json({
            values:
              number === 1
                ? Array.from({ length: 100 }, (_, i) => pull(i + 1))
                : [pull(100), pull(101)],
            ...(number === 1
              ? {
                  next: 'https://api.bitbucket.org/2.0/repositories/team/project/pullrequests?page=2',
                }
              : {}),
          });
        }
        const spec = `contributor/fork:${fixture.source.commit.hash}..${fixture.destination.commit.hash}`;
        for (const kind of ['diffstat', 'diff']) {
          if (url.pathname === `/2.0/repositories/team/project/pullrequests/101/${kind}`)
            return new Response(null, {
              status: 302,
              headers: {
                Location: `https://api.bitbucket.org/2.0/repositories/team/project/${kind}/${spec}?topic=true&from_pullrequest_id=101`,
              },
            });
        }
        if (url.pathname === `/2.0/repositories/team/project/diffstat/${spec}`) {
          const page = Number(url.searchParams.get('page'));
          const file = (n: number) => ({
            status: n === 101 ? 'renamed' : 'modified',
            old: { path: n === 101 ? 'before.ts' : `file-${n}.ts` },
            new: { path: `file-${n}.ts` },
            lines_added: 2,
            lines_removed: 1,
          });
          return Response.json({
            page,
            values:
              page === 1
                ? Array.from({ length: 100 }, (_, i) => file(i + 1))
                : [file(100), file(101)],
            ...(page === 1
              ? {
                  next: `https://api.bitbucket.org/2.0/repositories/team/project/diffstat/${spec}?page=2&topic=true`,
                }
              : {}),
          });
        }
        if (url.pathname === `/2.0/repositories/team/project/diff/${spec}`) {
          if (flags.bbDiffFail) return new Response('pull-secret', { status: 503 });
          if (url.searchParams.get('path') !== 'file-101.ts') throw new Error('Unexpected file');
          return new Response(
            'diff --git a/before.ts b/file-101.ts\n--- a/before.ts\n+++ b/file-101.ts\n@@ -1 +1 @@\n-old\n+<script>literal patch</script>\n',
            { headers: { 'Content-Type': 'text/plain' } },
          );
        }
        if (url.pathname === '/2.0/repositories/team/project/pullrequests/101') {
          if (flags.bbBlock) {
            flags.bbStarted = true;
            await new Promise<void>((resolve) => {
              if (init.signal?.aborted) resolve();
              else init.signal?.addEventListener('abort', () => resolve(), { once: true });
            });
            flags.bbAborted = true;
          }
          if (flags.bbFail)
            return Response.json({ error: { message: 'pull-secret' } }, { status: 503 });
          return Response.json({
            ...pull(101),
            queued: true,
            participants: Array.from({ length: 300 }, (_, i) => ({
              ...fixture.participants[0],
              user: {
                uuid: `{50000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}}`,
                display_name: `Reviewer ${i}`,
              },
            })),
            ...(flags.bbDeleted
              ? {
                  source: { repository: null, branch: null, commit: null },
                  comment_count: undefined,
                }
              : {}),
          });
        }
        throw new Error('Unexpected endpoint');
      };
    }, bitbucketPullFixture());
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
              token: 'pull-secret',
            },
          }),
        )
      ).kind,
    ).toBe('providerAccounts');
    await page.getByRole('button', { name: 'Pull requests', exact: true }).click();
    const workspace = page.getByRole('option', { name: 'Select workspace team', exact: true });
    await expect(workspace).toBeVisible();
    await workspace.click();
    await page.getByRole('option', { name: 'Select team/project', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Browse pull requests' });
    await expect(dialog.getByRole('status')).toContainText('100 pull requests loaded');
    await expect(dialog.getByRole('button', { name: 'New pull request', exact: true })).toHaveCount(
      0,
    );
    const list = dialog.getByRole('listbox', { name: 'Pull requests', exact: true });
    expect(await list.getByRole('option').count()).toBeLessThan(20);
    await list.focus();
    await list.press('End');
    await expect(
      list.getByRole('option', { name: 'Open pull request #100: Pull 100', exact: true }),
    ).toHaveAttribute('aria-selected', 'true');
    await dialog.getByRole('button', { name: 'Load more pull requests' }).click();
    await expect(dialog.getByRole('status')).toContainText('101 pull requests loaded');
    await dialog.getByLabel('Search loaded pull requests').fill('#101');
    await list.focus();
    await list.press('Enter');
    const details = dialog.getByRole('region', { name: 'Bitbucket pull-request details' });
    await expect(details.getByRole('heading')).toHaveText('#101 Needle pull');
    await expect(details).toContainText('contributor/fork:feature → team/project:main');
    await expect(details).toContainText('Comments: 5 · Open tasks: 2');
    await expect(details).toContainText('Queued: Yes');
    await expect(details).toContainText('Literal <script>description</script>');
    await expect(details.locator('script')).toHaveCount(0);
    await expect(details).toContainText('https://bitbucket.org/team/project/pull-requests/101');
    const people = details.getByRole('listbox', { name: 'Review participants' });
    expect(await people.getByRole('option').count()).toBeLessThan(20);
    await people.focus();
    await people.press('End');
    await expect(people.getByRole('option', { name: 'Reviewer 299', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(people.getByRole('option', { name: 'Reviewer 299', exact: true })).toContainText(
      'Changes requested',
    );
    await details.getByRole('button', { name: 'Show files', exact: true }).click();
    const files = details.getByRole('region', { name: 'Bitbucket changed files' });
    await expect(files.getByRole('status')).toHaveText('100 files loaded.');
    const fileList = files.getByRole('listbox', { name: 'Changed files', exact: true });
    expect(await fileList.getByRole('option').count()).toBeLessThan(20);
    await fileList.focus();
    await fileList.press('End');
    await expect(
      fileList.getByRole('option', { name: 'Open file-100.ts', exact: true }),
    ).toHaveAttribute('aria-selected', 'true');
    await files.getByRole('button', { name: 'Load more files' }).click();
    await expect(files.getByRole('status')).toHaveText('101 files loaded.');
    await files.getByLabel('Search loaded files').fill('before.ts');
    await fileList.focus();
    await fileList.press('Enter');
    await expect(files.getByRole('region', { name: 'File diff' })).toContainText(
      '<script>literal patch</script>',
    );
    await expect(files.locator('script')).toHaveCount(0);
    await expect(files.getByRole('option')).toContainText('renamed');
    await dialog.getByLabel('Automatic refresh', { exact: true }).selectOption('1');
    await page.clock.fastForward(60000);
    await expect(dialog.getByRole('status', { name: 'Automatic refresh status' })).toContainText(
      'Automatic refresh completed.',
    );
    await expect(files.getByLabel('Search loaded files')).toHaveValue('before.ts');
    await expect(fileList.getByRole('option')).toHaveAttribute('aria-selected', 'true');
    await expect(files.getByRole('region', { name: 'File diff' })).toContainText(
      '<script>literal patch</script>',
    );
    await dialog.getByLabel('Automatic refresh', { exact: true }).selectOption('0');
    await app.evaluate(() => Object.assign(globalThis, { bbDiffFail: true }));
    await files.getByRole('button', { name: 'Refresh diff' }).click();
    await expect(files.getByRole('alert')).toBeVisible();
    await expect(files.locator('.cm-editor')).toHaveCount(0);
    await expect(files).not.toContainText('pull-secret');
    await app.evaluate(() => Object.assign(globalThis, { bbDiffFail: false }));
    await files.getByRole('button', { name: 'Retry diff' }).click();
    await expect(files.locator('.cm-editor')).toBeVisible();
    await app.evaluate(() => Object.assign(globalThis, { bbDeleted: true }));
    await dialog.getByLabel('Automatic refresh', { exact: true }).selectOption('1');
    await page.clock.fastForward(60000);
    await expect(dialog.getByRole('status', { name: 'Automatic refresh status' })).toContainText(
      'Automatic refresh completed.',
    );
    expect(
      await app.evaluate(() => (globalThis as typeof globalThis & { bbPages: number[] }).bbPages),
    ).toEqual([1, 2, 1, 2, 1, 2]);
    await expect(dialog.getByLabel('Search loaded pull requests')).toHaveValue('#101');
    await expect(list.getByRole('option')).toHaveAttribute('aria-selected', 'true');
    await expect(details).toContainText('Source repository unavailable.');
    await expect(details).toContainText(
      'Files require an available source repository and full commit identifiers.',
    );
    await expect(details.getByRole('region', { name: 'File diff' })).toHaveCount(0);
    await expect(details).toContainText('Comments: Not available');
    await expect(details).not.toContainText('1'.repeat(40));
    await dialog.getByLabel('Automatic refresh', { exact: true }).selectOption('0');
    await app.evaluate(() => Object.assign(globalThis, { bbFail: true }));
    await details.getByRole('button', { name: 'Refresh details' }).click();
    await expect(details.getByRole('alert')).toBeVisible();
    await expect(details.getByRole('heading')).toHaveCount(0);
    await expect(dialog).not.toContainText('pull-secret');
    await app.evaluate(() => Object.assign(globalThis, { bbFail: false }));
    await details.getByRole('button', { name: 'Retry details' }).click();
    await expect(details.getByRole('heading')).toBeVisible();
    for (const state of ['merged', 'declined', 'superseded']) {
      await dialog.getByLabel('Pull-request state', { exact: true }).selectOption(state);
      await expect(list.getByRole('option')).toContainText(
        state[0]!.toUpperCase() + state.slice(1),
      );
      await expect(details).toHaveCount(0);
    }
    await dialog.getByLabel('Pull-request state', { exact: true }).selectOption('all');
    await expect(list.getByRole('option')).toHaveCount(4);
    await dialog.getByLabel('Pull-request state', { exact: true }).selectOption('open');
    await dialog.getByRole('button', { name: 'Load more pull requests' }).click();
    await dialog.getByLabel('Search loaded pull requests').fill('Needle');
    await app.evaluate(() => Object.assign(globalThis, { bbBlock: true }));
    await list.getByRole('option').click();
    await expect
      .poll(() =>
        app.evaluate(() => (globalThis as typeof globalThis & { bbStarted: boolean }).bbStarted),
      )
      .toBe(true);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect
      .poll(() =>
        app.evaluate(() => (globalThis as typeof globalThis & { bbAborted: boolean }).bbAborted),
      )
      .toBe(true);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
