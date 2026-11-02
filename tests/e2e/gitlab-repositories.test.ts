import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createFixture, fixtureGit } from '../../packages/test-fixtures/src/index.js';
import { authenticatedRemote } from '../../packages/test-fixtures/src/authenticated-remote.js';
import { fixtureProtection } from './provider-fixtures.js';

test('GitLab repository paging, subgroup search and keyboard selection feed protected native HTTPS clone and fetch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-gitlab-picker-'));
  const source = createFixture(join(root, 'source'));
  const bare = join(root, 'remote.git');
  fixtureGit(source, ['clone', '--bare', '.', bare]);
  const remote = await authenticatedRemote(bare, {
    basePath: '/org/sub/deep/chosen.git',
    password: 'gitlab-repository-secret',
  });
  const target = join(root, 'target');
  mkdirSync(target);
  const origin = new URL(remote.url).origin;
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
    env: {
      ...process.env,
      GIT_SSL_CAINFO: remote.certificate,
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  });
  try {
    await fixtureProtection(app);
    await app.evaluate(
      ({ session, dialog }, { origin, target }) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
        session.fromPartition('openkraken-providers').fetch = async (input, init) => {
          const url = new URL(String(input));
          if (
            url.origin !== origin ||
            new Headers(init?.headers).get('authorization') !== 'Bearer gitlab-repository-secret' ||
            init?.redirect !== 'error' ||
            init.credentials !== 'omit'
          )
            throw new Error('Unexpected provider request');
          if (url.pathname === '/api/v4/user')
            return Response.json({ id: 73, username: 'fixture-user' });
          if (url.pathname !== '/api/v4/projects') throw new Error('Unexpected endpoint');
          const first = url.searchParams.get('page') === '1';
          return Response.json(
            Array.from({ length: first ? 100 : 2 }, (_, index) => {
              const id = first ? index + 1 : index === 0 ? 100 : 101;
              const path =
                id === 101
                  ? 'org/sub/deep/chosen'
                  : `org/sub/project-${String(id - 1).padStart(3, '0')}`;
              return {
                id,
                path_with_namespace: path,
                path: path.split('/').at(-1),
                visibility: id === 101 ? 'internal' : 'private',
                archived: false,
                description: 'Subgroup project',
                http_url_to_repo: 'https://attacker.test/ignored.git',
              };
            }),
            { headers: { link: '<https://attacker.test/steal>; rel="next"' } },
          );
        };
      },
      { origin, target },
    );
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Provider accounts', exact: true }).click();
    const accounts = page.getByRole('dialog', { name: 'Provider accounts' });
    await accounts.getByLabel('Provider type', { exact: true }).selectOption('gitlab');
    await accounts.getByLabel('Provider host', { exact: true }).fill(origin);
    await accounts
      .getByLabel('Personal access token', { exact: true })
      .fill(remote.credentials.password);
    await accounts.getByRole('button', { name: 'Connect account', exact: true }).click();
    await expect(accounts.getByRole('button', { name: 'Forget fixture-user' })).toBeVisible();
    await accounts.getByRole('button', { name: 'Close accounts' }).click();
    await page.getByRole('button', { name: 'Clone', exact: true }).click();
    const clone = page.getByRole('dialog', { name: 'Clone repository' });
    await clone.getByRole('button', { name: 'Browse provider repositories' }).click();
    await expect(clone.getByRole('status')).toContainText('100 repositories loaded');
    expect(await clone.getByRole('option', { name: /^Select org\// }).count()).toBeLessThan(20);
    const list = clone.getByRole('listbox', { name: 'Repositories', exact: true });
    await list.focus();
    await list.press('End');
    await expect(clone.getByRole('option', { name: 'Select org/sub/project-099' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await clone.getByLabel('Search loaded repositories').fill('deep/chosen');
    await clone.getByRole('button', { name: 'Load more repositories' }).click();
    await expect(clone.getByRole('status')).toContainText('101 repositories loaded');
    await expect(clone.getByRole('option', { name: 'Select org/sub/deep/chosen' })).toContainText(
      'Internal',
    );
    await list.focus();
    await list.press('Enter');
    await expect(clone.getByLabel('Repository URL or absolute path')).toHaveValue(remote.url);
    await expect(
      clone.getByLabel('Use saved provider account for HTTPS authentication'),
    ).toBeChecked();
    await clone.getByRole('button', { name: 'Choose folder and clone' }).click();
    await expect(clone).toHaveCount(0);
    await expect(page.getByTestId('head')).toHaveText('main');
    expect(fixtureGit(target, ['rev-parse', 'HEAD'])).toBe(
      fixtureGit(source, ['rev-parse', 'HEAD']),
    );
    expect(remote.authenticated()).toBeGreaterThan(1);
    fixtureGit(source, ['commit', '--allow-empty', '-m', 'Nested remote update']);
    fixtureGit(source, ['push', bare, 'main']);
    fixtureGit(bare, ['update-server-info']);
    await page.getByRole('button', { name: 'Manage remotes', exact: true }).click();
    const remotes = page.getByRole('dialog', { name: 'Manage remotes' });
    await remotes
      .getByLabel('Fetch authentication', { exact: true })
      .selectOption({ label: `fixture-user · ${origin}` });
    await remotes.getByRole('button', { name: 'Fetch origin', exact: true }).click();
    await expect(remotes.getByRole('status')).toHaveText('Fetched origin');
    expect(fixtureGit(target, ['rev-parse', 'refs/remotes/origin/main'])).toBe(
      fixtureGit(source, ['rev-parse', 'HEAD']),
    );
    await expect(page.getByRole('dialog', { name: 'Git authentication', exact: true })).toHaveCount(
      0,
    );
    expect(fixtureGit(target, ['remote', 'get-url', 'origin'])).toBe(remote.url);
    expect(readFileSync(join(target, '.git/config'), 'utf8')).not.toContain(
      remote.credentials.password,
    );
    expect(readFileSync(join(root, 'profile/provider-accounts.json'), 'utf8')).not.toContain(
      remote.credentials.password,
    );
    await expect(page.locator('body')).not.toContainText(remote.credentials.password);
  } finally {
    await app.close();
    await remote.close();
    rmSync(root, { recursive: true, force: true });
  }
});
