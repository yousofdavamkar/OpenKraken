import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fixtureProtection } from './provider-fixtures.js';

test('Bitbucket account, workspace paging and repository search feed the saved-account clone form', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-bitbucket-picker-'));
  const app = await electron.launch({ args: [resolve('apps/desktop'), `--user-data-dir=${root}`] });
  try {
    await fixtureProtection(app);
    await app.evaluate(({ session }) => {
      let fail = true;
      const uuid = (prefix: number, id: number) =>
        `{${prefix}0000000-0000-4000-8000-${String(id).padStart(12, '0')}}`;
      session.fromPartition('openkraken-providers').fetch = async (input, init) => {
        const url = new URL(String(input));
        if (
          url.origin !== 'https://api.bitbucket.org' ||
          init?.redirect !== 'error' ||
          init.credentials !== 'omit' ||
          new Headers(init.headers).get('authorization') !== 'Bearer fixture-bitbucket-token'
        )
          throw new Error('Unexpected provider request');
        if (url.pathname === '/2.0/user')
          return Response.json({ uuid: uuid(1, 1), display_name: 'Fixture Person' });
        const first = url.searchParams.get('page') === '1';
        if (url.pathname === '/2.0/user/workspaces') {
          if (fail) {
            fail = false;
            return Response.json(
              { error: { message: 'Private provider detail' } },
              { status: 503 },
            );
          }
          return Response.json({
            values: Array.from({ length: first ? 100 : 2 }, (_, index) => {
              const id = first ? index + 1 : index === 0 ? 100 : 101;
              return {
                workspace: {
                  uuid: uuid(2, id),
                  slug: id === 101 ? 'chosen-team' : `team-${String(id).padStart(3, '0')}`,
                },
              };
            }),
            ...(first
              ? {
                  next: 'https://api.bitbucket.org/2.0/user/workspaces?page=2&pagelen=100&sort=slug',
                }
              : {}),
          });
        }
        if (url.pathname === '/2.0/repositories/chosen-team')
          return Response.json({
            values: Array.from({ length: first ? 100 : 2 }, (_, index) => {
              const id = first ? index + 1 : index === 0 ? 100 : 101;
              const slug = id === 101 ? 'chosen' : `project-${String(id).padStart(3, '0')}`;
              return {
                uuid: uuid(3, id),
                full_name: `chosen-team/${slug}`,
                workspace: { uuid: uuid(2, 101), slug: 'chosen-team' },
                scm: 'git',
                is_private: true,
                description: 'Workspace repository',
                links: { clone: [{ href: 'https://attacker.test/ignored.git' }] },
              };
            }),
            ...(first
              ? {
                  next: 'https://api.bitbucket.org/2.0/repositories/chosen-team?page=2&pagelen=100&sort=name',
                }
              : {}),
          });
        throw new Error('Unexpected endpoint');
      };
    });
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Provider accounts', exact: true }).click();
    const accounts = page.getByRole('dialog', { name: 'Provider accounts' });
    await accounts.getByLabel('Provider type', { exact: true }).selectOption('bitbucket');
    await expect(accounts.getByLabel('Provider host', { exact: true })).toHaveValue(
      'https://bitbucket.org',
    );
    await expect(accounts.getByLabel('Provider host', { exact: true })).toHaveAttribute(
      'readonly',
      '',
    );
    await accounts.getByLabel('API token', { exact: true }).fill('fixture-bitbucket-token');
    await accounts.getByRole('button', { name: 'Connect account', exact: true }).click();
    await expect(accounts.getByRole('button', { name: 'Forget Fixture Person' })).toBeVisible();
    await expect(accounts.getByLabel('API token', { exact: true })).toHaveValue('');
    await expect(accounts).toContainText('Bitbucket Cloud');
    await accounts.getByRole('button', { name: 'Close accounts' }).click();
    await page.getByRole('button', { name: 'Clone', exact: true }).click();
    const clone = page.getByRole('dialog', { name: 'Clone repository' });
    await clone.getByRole('button', { name: 'Browse provider repositories' }).click();
    await expect(clone.getByRole('alert')).toBeVisible();
    await expect(clone).not.toContainText('Private provider detail');
    await clone.getByRole('button', { name: 'Retry workspaces' }).click();
    await expect(clone.getByRole('status')).toContainText('100 workspaces loaded');
    expect(await clone.getByRole('option', { name: /^Select workspace / }).count()).toBeLessThan(
      20,
    );
    const workspaces = clone.getByRole('listbox', { name: 'Workspaces', exact: true });
    await workspaces.focus();
    await workspaces.press('End');
    await expect(
      clone.getByRole('option', { name: 'Select workspace team-100', exact: true }),
    ).toHaveAttribute('aria-selected', 'true');
    await clone.getByLabel('Search loaded workspaces').fill('chosen');
    await clone.getByRole('button', { name: 'Load more workspaces' }).click();
    await expect(clone.getByRole('status')).toContainText('101 workspaces loaded');
    await clone.getByRole('button', { name: 'Refresh workspaces' }).click();
    await expect(clone.getByRole('status')).toContainText('100 workspaces loaded · 0 match');
    await clone.getByRole('button', { name: 'Load more workspaces' }).click();
    await expect(clone.getByRole('status')).toContainText('101 workspaces loaded');
    await workspaces.focus();
    await workspaces.press('Enter');
    await expect(clone.getByRole('status')).toContainText('100 repositories loaded');
    await clone.getByLabel('Search loaded repositories').fill('/chosen');
    await clone.getByRole('button', { name: 'Load more repositories' }).click();
    await expect(clone.getByRole('status')).toContainText('101 repositories loaded');
    await clone.getByRole('button', { name: 'Refresh repositories' }).click();
    await expect(clone.getByRole('status')).toContainText('100 repositories loaded · 0 match');
    await clone.getByRole('button', { name: 'Load more repositories' }).click();
    await expect(clone.getByRole('status')).toContainText('101 repositories loaded');
    await expect(
      clone.getByRole('option', { name: 'Select chosen-team/chosen', exact: true }),
    ).toContainText('Private');
    const repositories = clone.getByRole('listbox', { name: 'Repositories', exact: true });
    await repositories.focus();
    await repositories.press('Enter');
    await expect(clone.getByLabel('Repository URL or absolute path')).toHaveValue(
      'https://bitbucket.org/chosen-team/chosen.git',
    );
    await expect(
      clone.getByLabel('Use saved provider account for HTTPS authentication'),
    ).toBeChecked();
    await clone.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'Issues', exact: true }).click();
    const issues = page.getByRole('dialog', { name: 'Browse issues', exact: true });
    await expect(issues).toContainText('Bitbucket collaboration is not available yet.');
    await expect(issues.getByRole('listbox')).toHaveCount(0);
    await issues.getByRole('button', { name: 'Close', exact: true }).click();
    expect(readFileSync(join(root, 'provider-accounts.json'), 'utf8')).not.toContain(
      'fixture-bitbucket-token',
    );
    await expect(page.locator('body')).not.toContainText('fixture-bitbucket-token');
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
