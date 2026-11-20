import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fixtureProtection } from './provider-fixtures.js';

for (const provider of ['github', 'gitlab'] as const) {
  for (const lost of [false, true]) {
    test(`${provider}: ${lost ? 'inspect after a lost creation receipt' : 'create a personal repository'} and select it for cloning`, async () => {
      const profile = await mkdtemp(join(tmpdir(), 'openkraken-create-provider-'));
      const app = await electron.launch({
        args: [resolve('apps/desktop'), '--user-data-dir=' + profile],
      });
      const github = provider === 'github';
      const origin = github ? 'https://github.com' : 'https://gitlab.com';
      try {
        await fixtureProtection(app);
        await app.evaluate(
          ({ session }, { github, lost }) => {
            const base = github ? 'https://api.github.com' : 'https://gitlab.com/api/v4';
            const project = github
              ? {
                  id: 41,
                  owner: { login: 'sam', id: 17 },
                  name: 'demo',
                  private: false,
                  description: 'A sample',
                  archived: false,
                }
              : {
                  id: 41,
                  path_with_namespace: 'sam/demo',
                  path: 'demo',
                  visibility: 'public',
                  description: 'A sample',
                  archived: false,
                };
            let posts = 0;
            let checks = 0;
            session.fromPartition('openkraken-providers').fetch = async (input, init) => {
              const url = new URL(String(input));
              if (String(input) === base + '/user')
                return Response.json({ id: 17, [github ? 'login' : 'username']: 'sam' });
              const endpoint = base + (github ? '/user/repos' : '/projects');
              const lookup = base + (github ? '/repos/sam/demo' : '/projects/sam%2Fdemo');
              if (url.href === lookup && init?.method === 'GET' && posts === 1) {
                checks++;
                if (checks === 1) return Response.json({}, { status: 404 });
                return Response.json(project);
              }
              if (url.origin + url.pathname !== endpoint) throw new Error('Unexpected endpoint');
              if (init?.method === 'POST') {
                posts++;
                const data = JSON.parse(String(init.body));
                if (
                  posts !== 1 ||
                  data.name !== 'demo' ||
                  data.description !== 'A sample' ||
                  !(github
                    ? data.private === false && data.auto_init === true
                    : data.visibility === 'public' && data.initialize_with_readme === true)
                )
                  throw new Error('Unexpected write');
                if (lost) throw new Error('Lost response after creation');
                return Response.json(project, { status: 201 });
              }
              return Response.json(posts === 1 ? [project] : []);
            };
          },
          { github, lost },
        );
        const page = await app.firstWindow();
        await page.getByRole('button', { name: 'Provider accounts', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'Provider accounts' });
        await dialog.getByLabel('Provider type').selectOption(provider);
        await dialog.getByLabel('Personal access token').fill('fixture-pat');
        await dialog.getByRole('button', { name: 'Connect account' }).click();
        await dialog.getByText('Create repository', { exact: true }).click();
        const form = dialog.getByRole('form', { name: 'Create personal repository' });
        await expect(form.getByLabel('Visibility')).toHaveValue('private');
        await form.getByLabel('Repository name').fill('bad/name');
        await expect(
          form.getByRole('button', { name: 'Create private repository' }),
        ).toBeDisabled();
        await form.getByLabel('Repository name').fill('demo');
        await form.getByLabel('Description (optional)').fill('A sample');
        await form.getByLabel('Visibility').selectOption('public');
        await form.getByLabel('Initialize with a README').check();
        await form.getByRole('button', { name: 'Create public repository' }).press('Enter');
        if (lost) {
          const check = form.getByRole('button', { name: 'Check sam/demo' });
          await expect(check).toBeVisible();
          await expect(form.getByRole('button', { name: 'Create public repository' })).toHaveCount(
            0,
          );
          await check.press('Enter');
          await expect(form.getByRole('alert')).toBeVisible();
          if (github) {
            await dialog.getByRole('button', { name: 'Close accounts' }).click();
            await page.getByRole('button', { name: 'Provider accounts', exact: true }).click();
            await dialog.getByText('Create repository', { exact: true }).click();
            await form.getByLabel('Repository name').fill('demo');
            await form.getByRole('button', { name: 'Check existing repository' }).click();
          } else await check.click();
        }
        await expect(
          dialog.getByRole('status').filter({
            hasText: lost ? 'Found sam/demo. Visibility: public.' : 'Created sam/demo.',
          }),
        ).toBeVisible();
        await expect(dialog.getByLabel('Clone URL')).toHaveValue(origin + '/sam/demo.git');
        await dialog.getByRole('button', { name: 'Close accounts', exact: true }).click();
        await page.getByRole('button', { name: 'Clone', exact: true }).click();
        const clone = page.getByRole('dialog', { name: 'Clone repository' });
        await clone.getByRole('button', { name: 'Browse provider repositories' }).click();
        await clone.getByRole('option', { name: 'Select sam/demo' }).click();
        await expect(clone.getByLabel('Repository URL or absolute path')).toHaveValue(
          origin + '/sam/demo.git',
        );
      } finally {
        await app.close();
        await rm(profile, { recursive: true, force: true });
      }
    });
  }
}
