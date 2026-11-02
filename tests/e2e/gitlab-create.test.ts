import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fixtureProtection } from './provider-fixtures.js';
import { gitlabMergeFixture } from '../gitlab-fixtures.js';

test('GitLab creation previews native templates, binds fork tips, preserves stale drafts and inspects uncertain creation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-gitlab-create-ui-'));
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    await fixtureProtection(app);
    await app.evaluate(({ session }, merge) => {
      const state = {
        head: '1'.repeat(40),
        uncertain: false,
        block: false,
        started: false,
        posts: [] as unknown[],
        merges: [] as unknown[],
      };
      Object.assign(globalThis, { mergeCreation: state });
      session.fromPartition('openkraken-providers').fetch = async (input, init) => {
        const url = new URL(String(input));
        if (
          url.origin !== 'https://gitlab.com' ||
          new Headers(init?.headers).get('authorization') !== 'Bearer creation-secret' ||
          init?.redirect !== 'error' ||
          init?.credentials !== 'omit'
        )
          throw new Error('Unexpected request');
        if (url.pathname === '/api/v4/user')
          return Response.json({ id: 73, username: 'contributor' });
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
          return Response.json({
            id: 77,
            path_with_namespace: 'group/subgroup/project',
            archived: false,
            default_branch: 'main',
          });
        if (url.pathname === '/api/v4/projects/contributor%2Fsubgroup%2Ffork')
          return Response.json({
            id: 88,
            path_with_namespace: 'contributor/subgroup/fork',
            archived: false,
            default_branch: 'main',
          });
        if (url.pathname === '/api/v4/projects/77/merge_requests')
          return Response.json(state.merges);
        if (url.pathname === '/api/v4/projects/77/templates/merge_requests')
          return Response.json([{ key: 'Feature', name: 'Feature checklist' }]);
        if (url.pathname === '/api/v4/projects/77/templates/merge_requests/Feature')
          return Response.json({
            name: 'Feature checklist',
            content: '## Tests\n<script>literal template</script>',
          });
        if (url.pathname === '/api/v4/projects/77/repository/branches/main')
          return Response.json({ name: 'main', commit: { id: '2'.repeat(40) } });
        if (url.pathname === '/api/v4/projects/88/repository/branches/feature%2Ftopic') {
          if (state.block) {
            state.started = true;
            await new Promise<void>((resolve) => {
              if (init?.signal?.aborted) resolve();
              else init?.signal?.addEventListener('abort', () => resolve(), { once: true });
            });
            throw new DOMException('Aborted', 'AbortError');
          }
          return Response.json({ name: 'feature/topic', commit: { id: state.head } });
        }
        if (url.pathname === '/api/v4/projects/88/merge_requests' && init?.method === 'POST') {
          const body = JSON.parse(String(init.body));
          state.posts.push(body);
          const result = {
            ...merge,
            iid: 6 + state.posts.length,
            id: 1006 + state.posts.length,
            title: body.title,
            description: body.description,
            source_branch: body.source_branch,
            target_branch: body.target_branch,
            sha: state.head,
            draft: true,
            allow_collaboration: body.allow_collaboration,
          };
          state.merges.push(result);
          return state.uncertain
            ? Response.json({ message: 'creation-secret' }, { status: 503 })
            : Response.json(result, { status: 201 });
        }
        throw new Error('Unexpected endpoint');
      };
    }, gitlabMergeFixture(7));
    const page = await app.firstWindow();
    await page.evaluate(() =>
      window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'providerConnect',
        options: { provider: 'gitlab', origin: 'https://gitlab.com', token: 'creation-secret' },
      }),
    );
    await page.getByRole('button', { name: 'Pull requests', exact: true }).click();
    await page.getByRole('option', { name: 'Select group/subgroup/project', exact: true }).click();
    await page.getByRole('button', { name: 'New merge request', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Create merge request', exact: true });
    await dialog.getByLabel('Source owner', { exact: true }).fill('contributor/subgroup');
    await dialog.getByLabel('Source repository', { exact: true }).fill('fork');
    await dialog.getByLabel('Source branch', { exact: true }).fill('feature/topic');
    await expect(dialog.getByLabel('Target branch', { exact: true })).toHaveValue('main');
    await dialog.getByLabel('MR title', { exact: true }).fill('Add feature');
    await dialog.getByLabel('Create as draft', { exact: true }).check();
    await dialog.getByLabel('Allow maintainers to edit the source branch', { exact: true }).check();
    await dialog.getByRole('combobox', { name: 'Template', exact: true }).selectOption('Feature');
    await dialog.getByRole('button', { name: 'Preview template', exact: true }).click();
    await expect(
      dialog.getByRole('region', { name: 'Template preview', exact: true }),
    ).toContainText('<script>literal template</script>');
    await expect(dialog.getByRole('textbox', { name: 'Description', exact: true })).toHaveValue('');
    await dialog
      .getByRole('button', { name: 'Replace description with template', exact: true })
      .click();
    await dialog.getByRole('button', { name: 'Preview MR', exact: true }).click();
    const review = dialog.getByRole('region', { name: 'Confirm MR creation', exact: true });
    await expect(review).toContainText('Draft: Add feature');
    await expect(review).toContainText('1'.repeat(40));
    await expect(dialog.getByRole('textbox', { name: 'Description', exact: true })).toBeDisabled();
    await app.evaluate(() => {
      (globalThis as typeof globalThis & { mergeCreation: { head: string } }).mergeCreation.head =
        '3'.repeat(40);
    });
    await dialog.getByRole('button', { name: 'Create confirmed MR', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('changed');
    await expect(dialog.getByRole('textbox', { name: 'Description', exact: true })).toHaveValue(
      '## Tests\n<script>literal template</script>',
    );
    expect(
      await app.evaluate(
        () =>
          (globalThis as typeof globalThis & { mergeCreation: { posts: unknown[] } }).mergeCreation
            .posts.length,
      ),
    ).toBe(0);
    await dialog.getByRole('button', { name: 'Preview MR', exact: true }).click();
    await dialog.getByRole('button', { name: 'Create confirmed MR', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('Created !7: Draft: Add feature');
    expect(
      await app.evaluate(
        () =>
          (globalThis as typeof globalThis & { mergeCreation: { posts: unknown[] } }).mergeCreation
            .posts,
      ),
    ).toEqual([
      {
        source_branch: 'feature/topic',
        target_branch: 'main',
        target_project_id: 77,
        title: 'Draft: Add feature',
        description: '## Tests\n<script>literal template</script>',
        allow_collaboration: true,
        remove_source_branch: false,
      },
    ]);
    await dialog.getByRole('button', { name: 'Close creation', exact: true }).click();
    await page.getByRole('button', { name: 'New merge request', exact: true }).click();
    await dialog.getByLabel('Source owner', { exact: true }).fill('contributor/subgroup');
    await dialog.getByLabel('Source repository', { exact: true }).fill('fork');
    await dialog.getByLabel('Source branch', { exact: true }).fill('feature/topic');
    await dialog.getByLabel('MR title', { exact: true }).fill('Second feature');
    await dialog.getByLabel('Create as draft', { exact: true }).check();
    await dialog.getByRole('button', { name: 'Preview MR', exact: true }).click();
    await app.evaluate(() => {
      (
        globalThis as typeof globalThis & { mergeCreation: { uncertain: boolean } }
      ).mergeCreation.uncertain = true;
    });
    await dialog.getByRole('button', { name: 'Create confirmed MR', exact: true }).click();
    await dialog
      .getByRole('button', { name: 'Check existing merge requests', exact: true })
      .click();
    await expect(
      dialog.getByRole('region', { name: 'Check MR creation result', exact: true }),
    ).toContainText('Draft: Second feature');
    expect(
      await app.evaluate(
        () =>
          (globalThis as typeof globalThis & { mergeCreation: { posts: unknown[] } }).mergeCreation
            .posts.length,
      ),
    ).toBe(2);
    await dialog.getByRole('button', { name: 'I checked; return to draft', exact: true }).click();
    await app.evaluate(() => {
      (
        globalThis as typeof globalThis & { mergeCreation: { block: boolean } }
      ).mergeCreation.block = true;
    });
    await dialog.getByRole('button', { name: 'Preview MR', exact: true }).click();
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (globalThis as typeof globalThis & { mergeCreation: { started: boolean } })
              .mergeCreation.started,
        ),
      )
      .toBe(true);
    await dialog.getByRole('button', { name: 'Cancel request', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('cancelled');
    await dialog.getByRole('button', { name: 'Close creation', exact: true }).click();
    await dialog.getByRole('button', { name: 'Keep editing', exact: true }).click();
    await expect(dialog.getByLabel('MR title', { exact: true })).toHaveValue('Second feature');
    await dialog.getByRole('button', { name: 'Close creation', exact: true }).click();
    await dialog.getByRole('button', { name: 'Discard draft', exact: true }).click();
    await expect(
      page.getByRole('dialog', { name: 'Browse merge requests', exact: true }),
    ).toBeVisible();
    await expect(page.locator('body')).not.toContainText('creation-secret');
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
