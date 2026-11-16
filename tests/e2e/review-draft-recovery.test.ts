import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { githubPullFixture } from '../../packages/test-fixtures/src/provider.js';
import { fixtureProtection } from './provider-fixtures.js';

const body = 'Please cover the recovery path.';
async function browse(app: ElectronApplication, first: boolean, changed: boolean) {
  await fixtureProtection(app);
  await app.evaluate(
    ({ session }, { pull, changed }) => {
      const state = { posts: 0 };
      Object.assign(globalThis, { reviewRecoveryFixture: state });
      const json = (value: unknown) =>
        new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
      session.fromPartition('openkraken-providers').fetch = async (input, init) => {
        const url = new URL(String(input));
        if (
          url.origin !== 'https://api.github.com' ||
          new Headers(init?.headers).get('authorization') !== 'token fixture-pat'
        )
          throw Error('Unexpected provider request');
        if (url.pathname === '/user') return json({ id: 321, login: 'fixture-user' });
        if (url.pathname === '/user/repos')
          return json([
            {
              id: 1,
              name: 'project',
              owner: { login: 'team' },
              description: '',
              private: true,
              archived: false,
            },
          ]);
        const current = {
          ...pull,
          head: { ...pull.head, sha: changed ? '3'.repeat(40) : pull.head.sha },
        };
        if (url.pathname === '/repos/team/project/pulls') return json([current]);
        if (url.pathname === '/repos/team/project/pulls/1') return json(current);
        if (url.pathname === '/repos/team/project/pulls/1/reviews') {
          if (init?.method === 'POST') {
            state.posts++;
            // The provider received the request, but the application never receives a reply.
            return new Promise<Response>(() => {});
          }
          return json([]);
        }
        throw Error('Unexpected endpoint');
      };
    },
    { pull: githubPullFixture(), changed },
  );
  const page = await app.firstWindow();
  if (first) {
    const result = await page.evaluate(() =>
      window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'providerConnect',
        options: { provider: 'github', origin: 'https://github.com', token: 'fixture-pat' },
      }),
    );
    expect(result.kind).toBe('providerAccounts');
  }
  await page.getByRole('button', { name: 'Pull requests', exact: true }).click();
  const browser = page.getByRole('dialog', { name: 'Browse pull requests' });
  await browser.getByRole('option', { name: 'Select team/project', exact: true }).click();
  await browser
    .getByRole('listbox', { name: 'Pull requests', exact: true })
    .getByRole('option')
    .click();
  return { page, details: browser.getByRole('region', { name: 'Pull-request details' }) };
}
function posts(app: ElectronApplication) {
  return app.evaluate(
    () =>
      (globalThis as typeof globalThis & { reviewRecoveryFixture: { posts: number } })
        .reviewRecoveryFixture.posts,
  );
}
for (const scenario of ['editing', 'changed commits', 'pending POST']) {
  test(`review draft survives main-process death while ${scenario}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'ok-review-recovery-'));
    const args = [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`];
    let app = await electron.launch({ args });
    try {
      let { page, details } = await browse(app, true, false);
      await details.getByRole('button', { name: 'Write review' }).click();
      let review = page.getByRole('dialog', { name: 'Write pull-request review' });
      await review.getByLabel('Review action').selectOption('REQUEST_CHANGES');
      await review.getByLabel('Review text').fill(body);
      await expect(review.getByText('Draft saved locally', { exact: true })).toBeVisible();
      const pending = scenario === 'pending POST',
        changed = scenario === 'changed commits';
      if (pending) {
        await review.getByRole('button', { name: 'Preview review' }).click();
        await review.getByRole('button', { name: 'Submit review', exact: true }).click();
        await expect.poll(() => posts(app)).toBe(1);
      } else expect(await posts(app)).toBe(0);
      const main = app.process(),
        exited = once(main, 'exit');
      expect(main.kill('SIGKILL')).toBe(true);
      await exited;
      app = await electron.launch({ args });
      if (changed) {
        await fixtureProtection(app, true);
        await app.evaluate(({ session }) => {
          Object.assign(globalThis, { offlineReads: 0 });
          session.fromPartition('openkraken-providers').fetch = async () => {
            (globalThis as typeof globalThis & { offlineReads: number }).offlineReads++;
            throw Error('offline');
          };
        });
        page = await app.firstWindow();
        await page.getByRole('button', { name: 'Provider accounts', exact: true }).click();
        const accounts = page.getByRole('dialog', { name: 'Provider accounts' });
        await accounts.getByRole('button', { name: 'Saved review drafts' }).click();
        const offline = page.getByRole('dialog', { name: 'Saved review drafts' });
        await offline
          .getByRole('button', { name: 'team/project #1 · Pull-request review' })
          .click();
        await expect(offline.getByLabel('Saved review text')).toHaveValue(body);
        await offline.getByRole('button', { name: 'Close', exact: true }).click();
        await accounts.getByRole('button', { name: 'Close accounts' }).click();
        expect(
          await app.evaluate(
            () => (globalThis as typeof globalThis & { offlineReads: number }).offlineReads,
          ),
        ).toBe(0);
      }
      ({ page, details } = await browse(app, false, changed));
      await details.getByRole('button', { name: 'Write review' }).click();
      review = page.getByRole('dialog', { name: 'Write pull-request review' });
      await expect(review.getByLabel('Review text')).toHaveValue(body);
      await expect(review.getByLabel('Review action')).toHaveValue('REQUEST_CHANGES');
      if (changed) {
        await expect(review).toContainText('These commits have changed.');
        await expect(review.getByRole('button', { name: 'Preview review' })).toHaveCount(0);
      } else if (pending) {
        await expect(review.getByRole('alert')).toContainText('may have received');
        await expect(review.getByRole('button', { name: 'Preview review' })).toHaveCount(0);
        await review.getByRole('button', { name: 'Check submitted reviews' }).click();
        await review.getByRole('button', { name: 'I checked; return to draft' }).click();
        await expect(review.getByRole('button', { name: 'Preview review' })).toBeVisible();
      } else await expect(review.getByRole('button', { name: 'Preview review' })).toBeVisible();
      await review.getByRole('button', { name: 'Close review' }).click();
      await review.getByRole('button', { name: 'Keep draft and close' }).click();
      await details.getByRole('button', { name: 'Saved review drafts' }).click();
      const saved = page.getByRole('dialog', { name: 'Saved review drafts' });
      await saved.getByRole('button', { name: 'Pull-request review', exact: true }).click();
      await expect(saved.getByLabel('Saved review text')).toHaveValue(body);
      await saved.getByRole('button', { name: 'Discard draft' }).click();
      await saved.getByRole('button', { name: 'Confirm discard' }).click();
      await expect(saved.getByText('No saved drafts for this pull request.')).toBeVisible();
      expect(await posts(app)).toBe(0);
    } finally {
      if (app.process().exitCode === null && app.process().signalCode === null) await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
