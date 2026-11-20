import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fixtureProtection } from './provider-fixtures.js';

type Provider = 'github' | 'enterprise' | 'gitlab';
async function setup(app: ElectronApplication, provider: Provider) {
  await fixtureProtection(app);
  await app.evaluate(({ session }, provider) => {
    const traffic = { reads: 0, posts: 0 };
    Object.assign(globalThis, { pullRecoveryTraffic: traffic });
    const gitlab = provider === 'gitlab';
    const origin = gitlab
      ? 'https://gitlab.com'
      : provider === 'enterprise'
        ? 'https://git.example.test'
        : 'https://api.github.com';
    const prefix = gitlab ? '/api/v4' : provider === 'enterprise' ? '/api/v3' : '';
    const target = gitlab ? 'group/subgroup/project' : 'team/project';
    const source = gitlab ? 'contributor/subgroup/fork' : 'contributor/fork';
    session.fromPartition('openkraken-providers').fetch = async (input, init) => {
      const url = new URL(String(input));
      if (
        url.origin !== origin ||
        !url.pathname.startsWith(prefix) ||
        new Headers(init?.headers).get('authorization') !==
          (gitlab ? 'Bearer fixture-pat' : 'token fixture-pat')
      )
        throw Error('Unexpected provider');
      const path = url.pathname.slice(prefix.length);
      if (init?.method === 'POST') {
        if (path !== (gitlab ? '/projects/88/merge_requests' : '/repos/team/project/pulls'))
          throw Error('Unexpected write');
        traffic.posts++;
        return new Promise<Response>(() => {});
      }
      traffic.reads++;
      if (path === '/user')
        return Response.json({ id: 321, login: 'fixture-user', username: 'fixture-user' });
      if (gitlab) {
        if (path === '/projects')
          return Response.json([
            {
              id: 77,
              path_with_namespace: target,
              path: 'project',
              description: '',
              visibility: 'private',
              archived: false,
            },
          ]);
        if (
          path === '/projects/' + encodeURIComponent(target) ||
          path === '/projects/' + encodeURIComponent(source)
        ) {
          const isTarget = path.endsWith(encodeURIComponent(target));
          return Response.json({
            id: isTarget ? 77 : 88,
            path_with_namespace: isTarget ? target : source,
            archived: false,
            default_branch: 'main',
          });
        }
        if (
          path === '/projects/77/merge_requests' ||
          path === '/projects/77/templates/merge_requests'
        )
          return Response.json([]);
        if (path === '/projects/77/repository/branches/main')
          return Response.json({ name: 'main', commit: { id: '2'.repeat(40) } });
        if (path === '/projects/88/repository/branches/feature%2Ftopic')
          return Response.json({ name: 'feature/topic', commit: { id: '1'.repeat(40) } });
      } else {
        if (path === '/user/repos')
          return Response.json([
            {
              id: 1,
              name: 'project',
              owner: { login: 'team' },
              private: true,
              archived: false,
              description: '',
            },
          ]);
        if (path === '/repos/team/project') return Response.json({ default_branch: 'main' });
        if (path === '/repos/team/project/pulls') return Response.json([]);
        if (path === '/repos/team/project/branches/main')
          return Response.json({ name: 'main', commit: { sha: '2'.repeat(40) } });
        if (path === '/repos/contributor/fork/branches/feature%2Ftopic')
          return Response.json({ name: 'feature/topic', commit: { sha: '1'.repeat(40) } });
        if (path === '/repos/team/project/git/commits/' + '2'.repeat(40))
          return Response.json({ sha: '2'.repeat(40), tree: { sha: '3'.repeat(40) } });
        if (path === '/repos/team/project/git/trees/' + '3'.repeat(40))
          return Response.json({ sha: '3'.repeat(40), truncated: false, tree: [] });
      }
      throw Error('Unexpected provider request ' + path);
    };
  }, provider);
  return app.firstWindow();
}
function traffic(app: ElectronApplication) {
  return app.evaluate(
    () =>
      (globalThis as typeof globalThis & { pullRecoveryTraffic: { reads: number; posts: number } })
        .pullRecoveryTraffic,
  );
}
async function kill(app: ElectronApplication) {
  const exited = once(app.process(), 'exit');
  expect(app.process().kill('SIGKILL')).toBe(true);
  await exited;
}
async function openCreate(app: ElectronApplication, provider: Provider) {
  const page = await setup(app, provider);
  const connected = await page.evaluate(
    (provider) =>
      window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'providerConnect',
        options: {
          provider: provider === 'gitlab' ? 'gitlab' : 'github',
          origin:
            provider === 'gitlab'
              ? 'https://gitlab.com'
              : provider === 'enterprise'
                ? 'https://git.example.test'
                : 'https://github.com',
          token: 'fixture-pat',
        },
      }),
    provider,
  );
  expect(connected.kind).toBe('providerAccounts');
  if (provider === 'enterprise') {
    await app.evaluate(({ session }) => {
      const connection = session.fromPartition('openkraken-providers');
      const fetch = connection.fetch.bind(connection);
      connection.fetch = async (input, init) => {
        if (String(input).includes('/git/trees/'))
          await new Promise<void>((resolve) =>
            Object.assign(globalThis, { releaseTemplates: resolve }),
          );
        return fetch(input, init);
      };
    });
  }
  await page.getByRole('button', { name: 'Pull requests', exact: true }).click();
  await page
    .getByRole('option', {
      name: 'Select ' + (provider === 'gitlab' ? 'group/subgroup/project' : 'team/project'),
      exact: true,
    })
    .click();
  await page
    .getByRole('button', {
      name: provider === 'gitlab' ? 'New merge request' : 'New pull request',
      exact: true,
    })
    .click();
  const dialog = page.getByRole('dialog', {
    name: provider === 'gitlab' ? 'Create merge request' : 'Create pull request',
    exact: true,
  });
  await dialog
    .getByLabel('Source owner', { exact: true })
    .fill(provider === 'gitlab' ? 'contributor/subgroup' : 'contributor');
  await dialog.getByLabel('Source repository', { exact: true }).fill('fork');
  await dialog.getByLabel('Source branch', { exact: true }).fill('feature/topic');
  await dialog
    .getByLabel(provider === 'gitlab' ? 'MR title' : 'PR title', { exact: true })
    .fill('Recover creation');
  await dialog
    .getByRole('textbox', { name: 'Description', exact: true })
    .fill('Private request description');
  await dialog.getByLabel('Create as draft').check();
  await dialog.getByLabel('Allow maintainers to edit the source branch').check();
  if (provider === 'enterprise') {
    await expect.poll(() => app.evaluate(() => 'releaseTemplates' in globalThis)).toBe(true);
    await expect(dialog.getByLabel('Target branch', { exact: true })).toHaveValue('');
    await app.evaluate(() =>
      (globalThis as typeof globalThis & { releaseTemplates: () => void }).releaseTemplates(),
    );
  }
  await expect(dialog.getByLabel('Target branch', { exact: true })).toHaveValue('main');
  await expect(dialog.getByText('Draft saved locally')).toBeVisible();
  return { page, dialog };
}

for (const provider of ['github', 'enterprise', 'gitlab'] as const)
  test(
    provider + ' creation survives process death and recovers a pending submission without replay',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'ok-pull-recovery-'));
      const args = [resolve('apps/desktop'), '--user-data-dir=' + join(root, 'profile')];
      let app = await electron.launch({ args });
      const abbreviation = provider === 'gitlab' ? 'MR' : 'PR';
      try {
        let { page, dialog } = await openCreate(app, provider);
        await dialog.getByRole('button', { name: 'Preview ' + abbreviation, exact: true }).click();
        await expect(
          dialog.getByRole('button', { name: 'Create confirmed ' + abbreviation }),
        ).toBeVisible();
        for (const pending of [false, true]) {
          await kill(app);
          app = await electron.launch({ args });
          page = await setup(app, provider);
          await page.getByRole('button', { name: 'Provider accounts', exact: true }).click();
          const accounts = page.getByRole('dialog', { name: 'Provider accounts', exact: true });
          await accounts.getByRole('button', { name: 'Saved creation drafts' }).click();
          await accounts
            .getByRole('button', {
              name: provider === 'gitlab' ? 'group/subgroup/project' : 'team/project',
              exact: true,
            })
            .click();
          dialog = page.getByRole('dialog', {
            name: provider === 'gitlab' ? 'Create merge request' : 'Create pull request',
            exact: true,
          });
          await expect(dialog.getByLabel(abbreviation + ' title', { exact: true })).toHaveValue(
            'Recover creation',
          );
          await expect(
            dialog.getByRole('textbox', { name: 'Description', exact: true }),
          ).toHaveValue('Private request description');
          await expect(dialog.getByLabel('Source owner', { exact: true })).toHaveValue(
            provider === 'gitlab' ? 'contributor/subgroup' : 'contributor',
          );
          await expect(dialog.getByLabel('Source repository', { exact: true })).toHaveValue('fork');
          await expect(dialog.getByLabel('Source branch', { exact: true })).toHaveValue(
            'feature/topic',
          );
          await expect(dialog.getByLabel('Target branch', { exact: true })).toHaveValue('main');
          await expect(dialog.getByLabel('Create as draft')).toBeChecked();
          await expect(
            dialog.getByLabel('Allow maintainers to edit the source branch'),
          ).toBeChecked();
          await expect(
            dialog.getByRole('button', { name: 'Create confirmed ' + abbreviation }),
          ).toHaveCount(0);
          expect(await traffic(app)).toEqual({ reads: 0, posts: 0 });
          if (!pending) {
            await dialog
              .getByRole('button', { name: 'Preview ' + abbreviation, exact: true })
              .click();
            await dialog.getByRole('button', { name: 'Create confirmed ' + abbreviation }).click();
            await expect.poll(async () => (await traffic(app)).posts).toBe(1);
          } else {
            await expect(
              dialog.getByRole('textbox', { name: 'Description', exact: true }),
            ).toHaveJSProperty('readOnly', true);
            await expect(
              dialog.getByRole('button', { name: 'Preview ' + abbreviation, exact: true }),
            ).toHaveCount(0);
            await dialog
              .getByRole('button', {
                name:
                  provider === 'gitlab'
                    ? 'Check existing merge requests'
                    : 'Check existing pull requests',
              })
              .click();
            await dialog.getByRole('button', { name: 'I checked; return to draft' }).click();
            await expect(
              dialog.getByRole('button', { name: 'Preview ' + abbreviation, exact: true }),
            ).toBeEnabled();
            expect((await traffic(app)).posts).toBe(0);
            await dialog.getByRole('button', { name: 'Close creation' }).click();
            await dialog.getByRole('button', { name: 'Discard draft', exact: true }).click();
            await expect(
              accounts.getByText('No saved creation drafts for this account.'),
            ).toBeVisible();
          }
        }
      } finally {
        if (app.process().exitCode === null && app.process().signalCode === null) await app.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

test('cancel during protected creation save prevents dispatch, and a changed draft cannot bypass review', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ok-pull-cancel-'));
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const { page, dialog } = await openCreate(app, 'github');
    await dialog.getByLabel('PR title').fill('Saved before submission');
    await expect(dialog.getByText('Draft saved locally')).toBeVisible();
    await app.evaluate(({ safeStorage }) => {
      const encrypt = safeStorage.encryptStringAsync.bind(safeStorage);
      safeStorage.encryptStringAsync = async (text) => {
        if (JSON.parse(text).draft?.uncertain)
          await new Promise<void>((resolve) =>
            Object.assign(globalThis, { releasePullRecord: resolve }),
          );
        return encrypt(text);
      };
    });
    await dialog.getByRole('button', { name: 'Preview PR' }).click();
    await dialog.getByRole('button', { name: 'Create confirmed PR' }).click();
    await expect.poll(() => app.evaluate(() => 'releasePullRecord' in globalThis)).toBe(true);
    await dialog.getByRole('button', { name: 'Cancel request' }).click();
    await app.evaluate(() =>
      (globalThis as typeof globalThis & { releasePullRecord: () => void }).releasePullRecord(),
    );
    await expect(dialog.getByRole('alert')).toContainText('cancelled before submission');
    expect((await traffic(app)).posts).toBe(0);
    // Simulate a second composer taking the same revision before this one submits.
    await page.evaluate(async () => {
      const acc = await window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'providerAccounts',
      });
      if (acc.kind !== 'providerAccounts') throw Error('Account missing');
      const scope = {
        accountId: acc.state.accounts[0]!.id,
        repository: { owner: 'team', name: 'project' },
      };
      const read = await window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'pullDraftRead',
        scope,
      });
      if (read.kind !== 'pullDraft' || !read.draft || read.draft.uncertain)
        throw Error('Editable draft missing');
      const save = await window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'pullDraftSave',
        scope,
        revision: read.revision,
        draft: { ...read.draft, title: 'Newer copy' },
      });
      if (save.kind !== 'pullDraft') throw Error('Concurrent write failed');
    });
    await app.evaluate(({ safeStorage }) => {
      safeStorage.encryptStringAsync = async () => {
        throw Error('fixture unavailable');
      };
    });
    await dialog.getByRole('button', { name: 'Preview PR' }).click();
    await dialog.getByRole('button', { name: 'Create confirmed PR' }).click();
    await expect(dialog.getByRole('alert')).toContainText('saved draft could not be verified');
    await expect(dialog.getByRole('button', { name: 'Submit without crash recovery' })).toHaveCount(
      0,
    );
    expect((await traffic(app)).posts).toBe(0);
    await dialog.getByRole('button', { name: 'Close creation' }).click();
    await dialog.getByRole('button', { name: 'Discard draft' }).click();
    await dialog.getByRole('button', { name: 'Close without saving' }).click();
    await page.getByRole('button', { name: 'New pull request', exact: true }).click();
    await expect(dialog.getByLabel('PR title')).toHaveValue('Newer copy');
    await dialog.getByRole('button', { name: 'Preview PR' }).click();
    await dialog.getByRole('button', { name: 'Create confirmed PR' }).click();
    await expect(
      dialog.getByRole('button', { name: 'Submit without crash recovery' }),
    ).toBeVisible();
    expect((await traffic(app)).posts).toBe(0);
    await app.evaluate(({ session }) => {
      const connection = session.fromPartition('openkraken-providers');
      const fetch = connection.fetch.bind(connection);
      connection.fetch = async (input, init) => {
        if (init?.method !== 'POST') return fetch(input, init);
        if (
          String(input) !== 'https://api.github.com/repos/team/project/pulls' ||
          JSON.parse(String(init.body)).title !== 'Newer copy'
        )
          throw Error('Unexpected creation');
        (globalThis as typeof globalThis & { pullRecoveryTraffic: { posts: number } })
          .pullRecoveryTraffic.posts++;
        return new Response('{}', { status: 422, headers: { 'content-type': 'application/json' } });
      };
    });
    await dialog.getByRole('button', { name: 'Submit without crash recovery' }).click();
    await expect(dialog.getByRole('alert')).toContainText('rejected');
    expect((await traffic(app)).posts).toBe(1);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
