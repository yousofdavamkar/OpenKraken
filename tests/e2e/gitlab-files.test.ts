import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fixtureProtection } from './provider-fixtures.js';
import { gitlabFileFixture, gitlabMergeFixture } from '../gitlab-fixtures.js';

test('GitLab file pages and literal patches retain selection on refresh and clear obsolete revisions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-gitlab-files-ui-'));
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    await fixtureProtection(app);
    await app.evaluate(
      ({ session }, { merge, file }) => {
        const state = {
          changed: false,
          updated: false,
          fail: false,
          blocked: false,
          started: false,
          cancelled: false,
          pages: [] as number[],
        };
        Object.assign(globalThis, { gitlabFiles: state });
        session.fromPartition('openkraken-providers').fetch = async (input, init) => {
          const url = new URL(String(input));
          if (
            url.origin !== 'https://gitlab.com' ||
            new Headers(init?.headers).get('authorization') !== 'Bearer file-secret'
          )
            throw new Error('Unexpected provider request');
          if (url.pathname === '/api/v4/user')
            return Response.json({ id: 73, username: 'fixture-user' });
          if (url.pathname === '/api/v4/projects')
            return Response.json([
              {
                id: 77,
                path_with_namespace: 'group/subgroup/project',
                path: 'project',
                description: '',
                visibility: 'private',
                archived: false,
              },
            ]);
          if (url.pathname === '/api/v4/projects/group%2Fsubgroup%2Fproject')
            return Response.json({ id: 77, path_with_namespace: 'group/subgroup/project' });
          if (url.pathname === '/api/v4/projects/77/merge_requests') return Response.json([merge]);
          if (url.pathname === '/api/v4/projects/77/merge_requests/7')
            return Response.json({
              ...merge,
              diff_refs: { ...merge.diff_refs, start_sha: (state.changed ? '4' : '3').repeat(40) },
            });
          if (url.pathname === '/api/v4/projects/77/merge_requests/7/diffs') {
            if (state.blocked) {
              state.started = true;
              await new Promise<void>((resolve) => {
                if (init?.signal?.aborted) resolve();
                else init?.signal?.addEventListener('abort', () => resolve(), { once: true });
              });
              state.cancelled = true;
            }
            if (state.fail) return Response.json({ message: 'file-secret' }, { status: 503 });
            const page = Number(url.searchParams.get('page'));
            state.pages.push(page);
            if (state.changed) return Response.json([{ ...file, new_path: 'new-revision.ts' }]);
            return Response.json(
              page === 1
                ? Array.from({ length: 100 }, (_, i) => ({
                    ...file,
                    new_path: `file-${i}.ts`,
                    ...(i === 0
                      ? { diff: '', collapsed: true }
                      : i === 1
                        ? { diff: '', too_large: true }
                        : i === 2
                          ? { diff: 'x'.repeat(262145) }
                          : {}),
                  }))
                : [
                    { ...file, new_path: 'file-99.ts' },
                    {
                      ...file,
                      new_path: 'needle.ts',
                      diff: state.updated ? '@@ -1 +1 @@\n-old\n+Updated patch\n' : file.diff,
                    },
                  ],
            );
          }
          throw new Error('Unexpected endpoint');
        };
      },
      { merge: gitlabMergeFixture(7), file: gitlabFileFixture() },
    );
    const page = await app.firstWindow();
    await page.clock.install();
    await page.evaluate(() =>
      window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'providerConnect',
        options: { provider: 'gitlab', origin: 'https://gitlab.com', token: 'file-secret' },
      }),
    );
    await page.getByRole('button', { name: 'Pull requests', exact: true }).click();
    await page.getByRole('option', { name: 'Select group/subgroup/project', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Browse merge requests' });
    await dialog
      .getByRole('option', { name: 'Open merge request !7: Merge 7', exact: true })
      .click();
    const detail = dialog.getByRole('region', { name: 'Merge-request details', exact: true });
    await detail.getByRole('button', { name: 'Files', exact: true }).click();
    const files = detail.getByRole('region', { name: 'Merge-request files', exact: true });
    await expect(files.getByRole('status')).toContainText('100 files loaded');
    const list = files.getByRole('listbox', { name: 'Changed files', exact: true });
    expect(await list.getByRole('option').count()).toBeLessThan(20);
    await list.getByRole('option').first().click();
    await expect(files).toContainText('GitLab collapsed this patch.');
    await list.focus();
    await list.press('ArrowDown');
    await list.press('Enter');
    await expect(files).toContainText(
      'GitLab omitted this patch because it exceeds its size limit.',
    );
    await list.press('ArrowDown');
    await list.press('Enter');
    await expect(files).toContainText('This patch exceeds the display limit and is truncated.');
    await files.getByRole('button', { name: 'Load more files', exact: true }).click();
    await expect(files.getByRole('status')).toContainText('101 files loaded');
    await list.focus();
    await list.press('End');
    await list.press('Enter');
    const patch = files.getByRole('region', { name: 'Selected file patch', exact: true });
    await expect(patch.getByRole('heading')).toHaveText('needle.ts');
    await expect(patch).toContainText('Previously: src/old.ts');
    await expect(patch).toContainText('100644 → 100755');
    await expect(patch).toContainText('<script>new</script>');
    await expect(patch.locator('script')).toHaveCount(0);
    await expect(patch.getByLabel('Provider patch', { exact: true })).toHaveAttribute(
      'contenteditable',
      'false',
    );
    await app.evaluate(() => {
      (
        globalThis as typeof globalThis & { gitlabFiles: { updated: boolean } }
      ).gitlabFiles.updated = true;
    });
    await dialog.getByLabel('Automatic refresh', { exact: true }).selectOption('1');
    await page.clock.fastForward(60000);
    await expect(patch).toContainText('Updated patch');
    await expect(list.getByRole('option', { selected: true })).toContainText('needle.ts');
    expect(
      await app.evaluate(
        () =>
          (globalThis as typeof globalThis & { gitlabFiles: { pages: number[] } }).gitlabFiles
            .pages,
      ),
    ).toEqual([1, 2, 1, 2]);
    await dialog.getByLabel('Automatic refresh', { exact: true }).selectOption('0');
    await app.evaluate(() => {
      (
        globalThis as typeof globalThis & { gitlabFiles: { changed: boolean } }
      ).gitlabFiles.changed = true;
    });
    await files.getByRole('button', { name: 'Refresh files', exact: true }).click();
    await expect(files.getByRole('alert')).toContainText('diff changed');
    await expect(patch).toHaveCount(0);
    await expect(list.getByRole('option')).toHaveCount(0);
    await detail.getByRole('button', { name: 'Refresh details', exact: true }).click();
    await expect(files.getByRole('status')).toContainText('1 files loaded');
    await expect(list.getByRole('option')).toContainText('new-revision.ts');
    await list.getByRole('option').click();
    await expect(patch.getByRole('heading')).toHaveText('new-revision.ts');
    await app.evaluate(() => {
      (
        globalThis as typeof globalThis & { gitlabFiles: { changed: boolean } }
      ).gitlabFiles.changed = false;
    });
    await dialog.getByLabel('Automatic refresh', { exact: true }).selectOption('1');
    await page.clock.fastForward(60000);
    await expect(files.getByRole('status')).toContainText('100 files loaded');
    await expect(patch).toHaveCount(0);
    await dialog.getByLabel('Automatic refresh', { exact: true }).selectOption('0');
    await app.evaluate(() => {
      (globalThis as typeof globalThis & { gitlabFiles: { fail: boolean } }).gitlabFiles.fail =
        true;
    });
    await files.getByRole('button', { name: 'Refresh files', exact: true }).click();
    await expect(files.getByRole('alert')).toContainText('GitLab request failed');
    await expect(dialog).not.toContainText('file-secret');
    await app.evaluate(() => {
      Object.assign((globalThis as typeof globalThis & { gitlabFiles: object }).gitlabFiles, {
        fail: false,
        blocked: true,
      });
    });
    await files.getByRole('button', { name: 'Retry files', exact: true }).click();
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (globalThis as typeof globalThis & { gitlabFiles: { started: boolean } }).gitlabFiles
              .started,
        ),
      )
      .toBe(true);
    await detail.getByRole('button', { name: 'Details', exact: true }).click();
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (globalThis as typeof globalThis & { gitlabFiles: { cancelled: boolean } }).gitlabFiles
              .cancelled,
        ),
      )
      .toBe(true);
    await expect(files).toHaveCount(0);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
