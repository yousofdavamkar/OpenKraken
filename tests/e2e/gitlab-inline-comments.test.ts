import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fixtureProtection } from './provider-fixtures.js';
import {
  gitlabDiscussionFixture,
  gitlabFileFixture,
  gitlabMergeFixture,
} from '../gitlab-fixtures.js';

test('GitLab inline comments bind renamed patch coordinates, preserve stale drafts and inspect uncertain results', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-gitlab-inline-ui-'));
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    await fixtureProtection(app);
    await app.evaluate(
      ({ session }, { merge, file, discussion }) => {
        const state = {
          changed: false,
          uncertain: false,
          posts: [] as Record<string, FormDataEntryValue>[],
          pages: [] as number[],
          discussions: [] as unknown[],
        };
        Object.assign(globalThis, { gitlabInline: state });
        session.fromPartition('openkraken-providers').fetch = async (input, init) => {
          const url = new URL(String(input));
          if (
            url.origin !== 'https://gitlab.com' ||
            new Headers(init?.headers).get('authorization') !== 'Bearer inline-secret' ||
            init?.redirect !== 'error' ||
            init?.credentials !== 'omit'
          )
            throw new Error('Unexpected request');
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
            const page = Number(url.searchParams.get('page'));
            state.pages.push(page);
            return Response.json(
              page === 1
                ? Array.from({ length: 100 }, (_, index) => ({
                    ...file,
                    new_path: index === 0 ? 'new.ts' : `file-${index}.ts`,
                  }))
                : [{ ...file, new_path: 'last.ts' }],
            );
          }
          if (url.pathname === '/api/v4/projects/77/merge_requests/7/discussions') {
            if (init?.method === 'GET') return Response.json(state.discussions);
            const fields = Object.fromEntries(await new Request(url, init).formData());
            state.posts.push(fields);
            const created = {
              ...discussion,
              id: state.posts.length.toString(16).padStart(40, '0'),
              notes: [
                {
                  ...discussion.notes[0],
                  id: state.posts.length * 10,
                  body: fields.body,
                  position: {
                    ...discussion.notes[0]!.position,
                    old_path: fields['position[old_path]'],
                    new_path: fields['position[new_path]'],
                    old_line: fields['position[old_line]']
                      ? Number(fields['position[old_line]'])
                      : null,
                    new_line: fields['position[new_line]']
                      ? Number(fields['position[new_line]'])
                      : null,
                  },
                },
              ],
            };
            state.discussions.push(created);
            return state.uncertain
              ? Response.json({}, { status: 503 })
              : Response.json(created, { status: 201 });
          }
          throw new Error('Unexpected endpoint');
        };
      },
      {
        merge: gitlabMergeFixture(7),
        file: {
          ...gitlabFileFixture('new.ts'),
          old_path: 'old.ts',
          diff: '@@ -10,3 +20,4 @@\n context\n-old\n+new\n+extra\n tail\n@@ -30 +40 @@\n-last\n+last-new\n\\ No newline at end of file\n',
        },
        discussion: gitlabDiscussionFixture(),
      },
    );
    const page = await app.firstWindow();
    await page.evaluate(() =>
      window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'providerConnect',
        options: { provider: 'gitlab', origin: 'https://gitlab.com', token: 'inline-secret' },
      }),
    );
    await page.getByRole('button', { name: 'Pull requests', exact: true }).click();
    await page.getByRole('option', { name: 'Select group/subgroup/project', exact: true }).click();
    const browser = page.getByRole('dialog', { name: 'Browse merge requests', exact: true });
    await browser
      .getByRole('option', { name: 'Open merge request !7: Merge 7', exact: true })
      .click();
    await browser.getByRole('button', { name: 'Files', exact: true }).click();
    const files = browser.getByRole('region', { name: 'Merge-request files', exact: true });
    await files.getByRole('button', { name: 'Load more files', exact: true }).click();
    await expect(files.getByRole('status')).toContainText('101 files loaded');
    const list = files.getByRole('listbox', { name: 'Changed files', exact: true });
    await list.focus();
    await list.press('Home');
    await list.press('Enter');
    const patch = files.getByLabel('Provider patch', { exact: true });
    await patch
      .locator('.cm-line')
      .filter({ hasText: /^-old$/ })
      .click();
    await expect(files).toContainText('Selected old line 11');
    await patch
      .locator('.cm-line')
      .filter({ hasText: /^\+new$/ })
      .click();
    await expect(files).toContainText('Selected new line 21');
    await patch
      .locator('.cm-line')
      .filter({ hasText: /^ tail$/ })
      .click();
    await expect(files).toContainText('Selected old line 12 · new line 23');
    await files.getByRole('button', { name: 'Comment on selected line', exact: true }).click();
    const action = page.getByRole('dialog', { name: 'GitLab discussion action', exact: true });
    await expect(action).toContainText('old.ts → new.ts');
    await action
      .getByLabel('Comment', { exact: true })
      .fill('Explain this <script>context</script>');
    await action.getByRole('button', { name: 'Review discussion action', exact: true }).click();
    await expect(
      action.getByRole('region', { name: 'Reviewed inline location', exact: true }),
    ).toContainText('Old line 12 · New line 23');
    await expect(
      action.getByRole('region', { name: 'Reviewed inline location', exact: true }),
    ).toContainText(' tail');
    await app.evaluate(() => {
      (
        globalThis as typeof globalThis & { gitlabInline: { changed: boolean } }
      ).gitlabInline.changed = true;
    });
    await action.getByRole('button', { name: 'Confirm discussion action', exact: true }).click();
    await expect(action.getByRole('alert')).toContainText('diff changed');
    await expect(action.getByLabel('Comment', { exact: true })).toHaveValue(
      'Explain this <script>context</script>',
    );
    expect(
      await app.evaluate(
        () =>
          (globalThis as typeof globalThis & { gitlabInline: { posts: unknown[] } }).gitlabInline
            .posts.length,
      ),
    ).toBe(0);
    await app.evaluate(() => {
      (
        globalThis as typeof globalThis & { gitlabInline: { changed: boolean } }
      ).gitlabInline.changed = false;
    });
    await action.getByRole('button', { name: 'Review discussion action', exact: true }).click();
    await action.getByRole('button', { name: 'Confirm discussion action', exact: true }).click();
    await expect(action.getByRole('status')).toContainText('Created discussion #10');
    const posts = await app.evaluate(
      () =>
        (globalThis as typeof globalThis & { gitlabInline: { posts: unknown[]; pages: number[] } })
          .gitlabInline,
    );
    expect(posts.posts).toEqual([
      {
        body: 'Explain this <script>context</script>',
        'position[position_type]': 'text',
        'position[base_sha]': '2'.repeat(40),
        'position[head_sha]': '1'.repeat(40),
        'position[start_sha]': '3'.repeat(40),
        'position[old_path]': 'old.ts',
        'position[new_path]': 'new.ts',
        'position[old_line]': '12',
        'position[new_line]': '23',
      },
    ]);
    expect(posts.pages.slice(0, 3)).toEqual([1, 2, 1]);
    await action.getByRole('button', { name: 'Close action', exact: true }).click();
    await patch
      .locator('.cm-line')
      .filter({ hasText: /^\\ No newline/ })
      .click();
    await expect(
      files.getByRole('button', { name: 'Comment on selected line', exact: true }),
    ).toHaveCount(0);
    await patch
      .locator('.cm-line')
      .filter({ hasText: /^\+last-new$/ })
      .click();
    await expect(files).toContainText('Selected new line 40');
    await files.getByRole('button', { name: 'Comment on selected line', exact: true }).click();
    await action.getByLabel('Comment', { exact: true }).fill('Later hunk comment');
    await action.getByRole('button', { name: 'Review discussion action', exact: true }).click();
    await app.evaluate(() => {
      (
        globalThis as typeof globalThis & { gitlabInline: { uncertain: boolean } }
      ).gitlabInline.uncertain = true;
    });
    await action.getByRole('button', { name: 'Confirm discussion action', exact: true }).click();
    await action.getByRole('button', { name: 'Check existing results', exact: true }).click();
    const inspection = action.getByRole('region', { name: 'Existing results', exact: true });
    await inspection.getByRole('combobox').selectOption('0'.repeat(39) + '2');
    await expect(inspection).toContainText('Later hunk comment');
    await inspection
      .getByRole('button', { name: 'Show diff context for note #20', exact: true })
      .click();
    await expect(inspection).toContainText('New line 40');
    expect(
      await app.evaluate(
        () =>
          (globalThis as typeof globalThis & { gitlabInline: { posts: unknown[] } }).gitlabInline
            .posts.length,
      ),
    ).toBe(2);
    await expect(action.locator('script')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('inline-secret');
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
