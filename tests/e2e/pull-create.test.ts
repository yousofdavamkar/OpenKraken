import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fixtureProtection } from './provider-fixtures.js';
import { githubPullFixture } from '../../packages/test-fixtures/src/provider.js';

test('PR creation previews templates and branch tips, preserves stale drafts and checks uncertain results without retries', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-pr-create-ui-'));
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    await fixtureProtection(app);
    await app.evaluate(({ session }, pull) => {
      const state = {
        head: '1'.repeat(40),
        posts: [] as unknown[],
        pulls: [] as unknown[],
        uncertain: false,
        blocked: false,
        started: false,
        aborted: false,
      };
      Object.assign(globalThis, { createFixture: state });
      const template = '## Summary\n<img src="https://attacker.test/pixel">\n## Tests\n';
      const json = (value: unknown, status = 200) =>
        new Response(JSON.stringify(value), {
          status,
          headers: { 'content-type': 'application/json' },
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
        if (url.pathname === '/repos/team/project') return json({ default_branch: 'main' });
        if (url.pathname === '/repos/team/project/branches/main')
          return json({ name: 'main', commit: { sha: '2'.repeat(40) } });
        if (url.pathname === '/repos/contributor/fork/branches/feature%2Fnested') {
          if (state.blocked) {
            state.started = true;
            await new Promise<void>((resolve) => {
              if (init?.signal?.aborted) resolve();
              else init?.signal?.addEventListener('abort', () => resolve(), { once: true });
            });
            state.aborted = true;
            throw new DOMException('Aborted', 'AbortError');
          }
          return json({ name: 'feature/nested', commit: { sha: state.head } });
        }
        if (url.pathname === `/repos/team/project/git/commits/${'2'.repeat(40)}`)
          return json({ sha: '2'.repeat(40), tree: { sha: '3'.repeat(40) } });
        if (url.pathname === `/repos/team/project/git/trees/${'3'.repeat(40)}`)
          return json({
            sha: '3'.repeat(40),
            truncated: false,
            tree: [
              {
                path: 'pull_request_template.md',
                mode: '100644',
                type: 'blob',
                sha: '4'.repeat(40),
                size: Buffer.byteLength(template),
              },
            ],
          });
        if (url.pathname === `/repos/team/project/git/blobs/${'4'.repeat(40)}`)
          return json({
            sha: '4'.repeat(40),
            encoding: 'base64',
            size: Buffer.byteLength(template),
            content: Buffer.from(template).toString('base64'),
          });
        if (url.pathname === '/repos/team/project/pulls') {
          if (init?.method === 'POST') {
            const body = JSON.parse(String(init.body)) as {
              title: string;
              body: string;
              draft: boolean;
            };
            state.posts.push(body);
            const created = {
              ...pull,
              number: 100 + state.posts.length,
              title: body.title,
              body: body.body,
              draft: body.draft,
              head: {
                ...pull.head,
                ref: 'feature/nested',
                sha: state.head,
                repo: { owner: { login: 'contributor' }, name: 'fork' },
              },
              base: { ...pull.base, repo: { owner: { login: 'team' }, name: 'project' } },
            };
            state.pulls.unshift(created);
            return state.uncertain ? json({ message: 'fixture-pat' }, 500) : json(created, 201);
          }
          return json(state.pulls);
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
    await browser.getByRole('button', { name: 'New pull request' }).click();
    const composer = page.getByRole('dialog', { name: 'Create pull request', exact: true });
    await expect(composer.getByLabel('Target branch')).toHaveValue('main');
    await composer.getByLabel('Source owner', { exact: true }).fill('contributor');
    await composer.getByLabel('Source repository', { exact: true }).fill('fork');
    await composer.getByLabel('Source branch', { exact: true }).fill('feature/nested');
    await composer.getByLabel('PR title').fill('Create fixture PR');
    await composer
      .getByRole('textbox', { name: 'Description', exact: true })
      .fill('Keep this until replacement.');
    await composer
      .getByRole('combobox', { name: 'Template', exact: true })
      .selectOption('pull_request_template.md');
    await composer.getByRole('button', { name: 'Preview template' }).click();
    await expect(composer.getByRole('region', { name: 'Template preview' })).toContainText(
      '<img src=',
    );
    await expect(composer.locator('img')).toHaveCount(0);
    await expect(composer.getByRole('textbox', { name: 'Description', exact: true })).toHaveValue(
      'Keep this until replacement.',
    );
    await composer.getByRole('button', { name: 'Replace description with template' }).click();
    await expect(composer.getByRole('textbox', { name: 'Description', exact: true })).toHaveValue(
      /## Summary/,
    );
    await composer.getByLabel('Create as draft').check();
    await composer.getByRole('button', { name: 'Preview PR', exact: true }).click();
    await expect(composer.getByRole('region', { name: 'Confirm PR creation' })).toContainText(
      '1'.repeat(40),
    );
    await expect(composer.getByLabel('PR title')).toBeDisabled();
    const posts = () =>
      app.evaluate(
        () =>
          (globalThis as typeof globalThis & { createFixture: { posts: unknown[] } }).createFixture
            .posts,
      );
    expect(await posts()).toEqual([]);
    await app.evaluate(() => {
      (globalThis as typeof globalThis & { createFixture: { head: string } }).createFixture.head =
        '5'.repeat(40);
    });
    await composer.getByRole('button', { name: 'Create confirmed PR' }).click();
    await expect(composer.getByRole('alert')).toContainText('branch commits changed');
    expect(await posts()).toEqual([]);
    await expect(composer.getByLabel('PR title')).toHaveValue('Create fixture PR');
    await composer.getByRole('button', { name: 'Close creation' }).click();
    await expect(composer.getByRole('region', { name: 'Discard PR draft' })).toBeVisible();
    await composer.getByRole('button', { name: 'Keep editing' }).click();
    await composer.getByRole('button', { name: 'Preview PR', exact: true }).click();
    await expect(composer.getByRole('region', { name: 'Confirm PR creation' })).toContainText(
      '5'.repeat(40),
    );
    await composer.getByRole('button', { name: 'Create confirmed PR' }).click();
    await expect(composer.getByRole('status')).toContainText('Created #101: Create fixture PR');
    expect(await posts()).toEqual([
      {
        title: 'Create fixture PR',
        body: '## Summary\n<img src="https://attacker.test/pixel">\n## Tests\n',
        head: 'contributor:feature/nested',
        head_repo: 'fork',
        base: 'main',
        draft: true,
        maintainer_can_modify: false,
      },
    ]);
    await page.screenshot({ path: 'test-results/provider-pr-created.png' });
    await composer.getByRole('button', { name: 'Close creation' }).click();
    await expect(
      browser.getByRole('listbox', { name: 'Pull requests', exact: true }),
    ).toContainText('#101');
    await browser.getByRole('button', { name: 'New pull request' }).click();
    await expect(composer.getByLabel('Target branch')).toHaveValue('main');
    await composer.getByLabel('Source owner', { exact: true }).fill('contributor');
    await composer.getByLabel('Source repository', { exact: true }).fill('fork');
    await composer.getByLabel('Source branch', { exact: true }).fill('feature/nested');
    await composer.getByLabel('PR title').fill('Uncertain creation');
    await app.evaluate(() => {
      (
        globalThis as typeof globalThis & { createFixture: { uncertain: boolean } }
      ).createFixture.uncertain = true;
    });
    await composer.getByRole('button', { name: 'Preview PR', exact: true }).click();
    await composer.getByRole('button', { name: 'Create confirmed PR' }).click();
    await expect(composer.getByRole('alert')).toContainText('may have created');
    await expect(composer).not.toContainText('fixture-pat');
    await expect(composer.getByRole('button', { name: 'Preview PR', exact: true })).toHaveCount(0);
    await composer.getByRole('button', { name: 'Check existing pull requests' }).click();
    await expect(composer.getByRole('region', { name: 'Check PR creation result' })).toContainText(
      '#102 Uncertain creation',
    );
    await composer.getByRole('button', { name: 'I checked; return to draft' }).click();
    await expect(composer.getByLabel('PR title')).toHaveValue('Uncertain creation');
    expect(await posts()).toHaveLength(2);
    await app.evaluate(() => {
      (
        globalThis as typeof globalThis & { createFixture: { blocked: boolean } }
      ).createFixture.blocked = true;
    });
    await composer.getByRole('button', { name: 'Preview PR', exact: true }).click();
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (globalThis as typeof globalThis & { createFixture: { started: boolean } })
              .createFixture.started,
        ),
      )
      .toBe(true);
    await expect(composer.getByRole('button', { name: 'Close creation' })).toBeDisabled();
    await composer.getByRole('button', { name: 'Cancel request' }).click();
    await expect(composer.getByRole('alert')).toContainText('cancelled');
    expect(await posts()).toHaveLength(2);
    await composer.getByRole('button', { name: 'Close creation' }).click();
    await composer.getByRole('button', { name: 'Discard draft' }).click();
    await browser.getByRole('button', { name: 'Close', exact: true }).click();
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
