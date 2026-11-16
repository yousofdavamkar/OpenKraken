import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fixtureProtection } from './provider-fixtures.js';

async function setup(app: ElectronApplication) {
  await fixtureProtection(app);
  await app.evaluate(({ session }) => {
    const traffic = { reads: 0, posts: 0 };
    Object.assign(globalThis, { issueRecoveryTraffic: traffic });
    const json = (value: unknown) =>
      new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    session.fromPartition('openkraken-providers').fetch = async (input, init) => {
      const url = new URL(String(input));
      if (
        url.origin !== 'https://api.github.com' ||
        new Headers(init?.headers).get('authorization') !== 'token fixture-pat'
      )
        throw Error('Unexpected provider');
      if (init?.method === 'POST' && url.pathname === '/repos/team/project/issues') {
        traffic.posts++;
        return new Promise<Response>(() => {});
      }
      traffic.reads++;
      if (url.pathname === '/user') return json({ id: 321, login: 'fixture-user' });
      if (url.pathname === '/user/repos')
        return json([
          {
            id: 1,
            name: 'project',
            owner: { login: 'team' },
            private: true,
            archived: false,
            description: '',
          },
        ]);
      if (url.pathname === '/repos/team/project/issues') return json([]);
      throw Error('Unexpected provider request');
    };
  });
  return app.firstWindow();
}
function traffic(app: ElectronApplication) {
  return app.evaluate(
    () =>
      (globalThis as typeof globalThis & { issueRecoveryTraffic: { posts: number; reads: number } })
        .issueRecoveryTraffic,
  );
}
async function kill(app: ElectronApplication) {
  const main = app.process(),
    exited = once(main, 'exit');
  expect(main.kill('SIGKILL')).toBe(true);
  await exited;
}
async function openCreate(page: Awaited<ReturnType<typeof setup>>) {
  const connected = await page.evaluate(() =>
    window.openkraken.request({
      id: crypto.randomUUID(),
      method: 'providerConnect',
      options: { provider: 'github', origin: 'https://github.com', token: 'fixture-pat' },
    }),
  );
  expect(connected.kind).toBe('providerAccounts');
  await page.getByRole('button', { name: 'Issues', exact: true }).click();
  const browser = page.getByRole('dialog', { name: 'Browse issues' });
  await browser.getByRole('option', { name: 'Select team/project' }).click();
  await browser.getByRole('button', { name: 'New issue' }).click();
  return page.getByRole('dialog', { name: 'Issue action', exact: true });
}
test('issue draft survives two process deaths and opens offline without replaying a pending POST', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ok-issue-relaunch-'));
  const args = [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`];
  let app = await electron.launch({ args });
  try {
    let page = await setup(app);
    let dialog = await openCreate(page);
    await dialog.getByLabel('Issue title').fill('Recover pending issue');
    await dialog.getByLabel('Description').fill('Private description');
    await expect(dialog.getByText('Draft saved locally')).toBeVisible();
    await dialog.getByRole('button', { name: 'Review issue action' }).click();
    expect((await traffic(app)).posts).toBe(0);
    for (const pending of [false, true]) {
      await kill(app);
      app = await electron.launch({ args });
      page = await setup(app);
      await page.getByRole('button', { name: 'Provider accounts', exact: true }).click();
      const accounts = page.getByRole('dialog', { name: 'Provider accounts' });
      await accounts.getByRole('button', { name: 'Saved issue drafts' }).click();
      await accounts.getByRole('button', { name: 'team/project · Create issue' }).click();
      dialog = page.getByRole('dialog', { name: 'Issue action', exact: true });
      await expect(dialog.getByLabel('Issue title')).toHaveValue('Recover pending issue');
      await expect(dialog.getByLabel('Description')).toHaveValue('Private description');
      await expect(dialog.getByRole('button', { name: 'Confirm issue action' })).toHaveCount(0);
      expect(await traffic(app)).toEqual({ reads: 0, posts: 0 });
      if (!pending) {
        await dialog.getByRole('button', { name: 'Review issue action' }).click();
        await dialog.getByRole('button', { name: 'Confirm issue action' }).click();
        await expect.poll(async () => (await traffic(app)).posts).toBe(1);
      } else {
        await expect(dialog.getByLabel('Description')).toBeDisabled();
        await expect(dialog.getByRole('button', { name: 'Review issue action' })).toHaveCount(0);
        await dialog.getByRole('button', { name: 'Check existing results' }).click();
        await expect(dialog.getByRole('region', { name: 'Existing results' })).toBeVisible();
        expect(await traffic(app)).toEqual({ reads: 2, posts: 0 });
        await dialog.getByRole('button', { name: 'I checked; review again' }).click();
        await expect(dialog.getByRole('button', { name: 'Review issue action' })).toBeEnabled();
        await dialog.getByRole('button', { name: 'Close action' }).click();
        await dialog.getByRole('button', { name: 'Discard draft' }).click();
        await expect(accounts.getByText('No saved issue drafts for this account.')).toBeVisible();
        expect(await traffic(app)).toEqual({ reads: 2, posts: 0 });
      }
    }
  } finally {
    if (app.process().exitCode === null && app.process().signalCode === null) await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('cancel during protected issue save prevents dispatch, and a changed draft cannot bypass review', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ok-issue-cancel-'));
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await setup(app);
    const dialog = await openCreate(page);
    await dialog.getByLabel('Issue title').fill('Saved before submission');
    await expect(dialog.getByText('Draft saved locally')).toBeVisible();
    await app.evaluate(({ safeStorage }) => {
      const encrypt = safeStorage.encryptStringAsync.bind(safeStorage);
      safeStorage.encryptStringAsync = async (text) => {
        if (JSON.parse(text).draft?.uncertain)
          await new Promise<void>((resolve) =>
            Object.assign(globalThis, { releaseIssueRecord: resolve }),
          );
        return encrypt(text);
      };
    });
    await dialog.getByRole('button', { name: 'Review issue action' }).click();
    await dialog.getByRole('button', { name: 'Confirm issue action' }).click();
    await expect.poll(() => app.evaluate(() => 'releaseIssueRecord' in globalThis)).toBe(true);
    await dialog.getByRole('button', { name: 'Cancel request' }).click();
    await app.evaluate(() =>
      (globalThis as typeof globalThis & { releaseIssueRecord: () => void }).releaseIssueRecord(),
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
        intent: { action: 'create' as const },
      };
      const read = await window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'issueDraftRead',
        scope,
      });
      if (read.kind !== 'issueDraft' || !read.draft || read.draft.uncertain)
        throw Error('Editable draft missing');
      const save = await window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'issueDraftSave',
        scope,
        revision: read.revision,
        draft: { ...read.draft, title: 'Newer copy' },
      });
      if (save.kind !== 'issueDraft') throw Error('Concurrent write failed');
    });
    await app.evaluate(({ safeStorage }) => {
      safeStorage.encryptStringAsync = async () => {
        throw Error('fixture unavailable');
      };
    });
    await dialog.getByRole('button', { name: 'Review issue action' }).click();
    await dialog.getByRole('button', { name: 'Confirm issue action' }).click();
    await expect(dialog.getByRole('alert')).toContainText('saved draft could not be verified');
    await expect(dialog.getByRole('button', { name: 'Submit without crash recovery' })).toHaveCount(
      0,
    );
    expect((await traffic(app)).posts).toBe(0);
    await dialog.getByRole('button', { name: 'Close action' }).click();
    await dialog.getByRole('button', { name: 'Discard draft' }).click();
    await dialog.getByRole('button', { name: 'Close without saving changes' }).click();
    await page.getByRole('button', { name: 'New issue', exact: true }).click();
    await expect(dialog.getByLabel('Issue title')).toHaveValue('Newer copy');
    await dialog.getByRole('button', { name: 'Review issue action' }).click();
    await dialog.getByRole('button', { name: 'Confirm issue action' }).click();
    await expect(
      dialog.getByRole('button', { name: 'Submit without crash recovery' }),
    ).toBeVisible();
    expect((await traffic(app)).posts).toBe(0);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
