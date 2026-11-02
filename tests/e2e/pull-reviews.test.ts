import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fixtureProtection } from './provider-fixtures.js';
import { githubPullFixture } from '../../packages/test-fixtures/src/provider.js';

test('PR patches and reviews preserve drafts, reject stale commits and submit only after confirmation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-review-ui-'));
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    await fixtureProtection(app);
    await app.evaluate(({ session }, pull) => {
      const state = {
        head: pull.head.sha,
        posts: [] as unknown[],
        uncertain: false,
        reviews: [] as unknown[],
      };
      Object.assign(globalThis, { reviewFixture: state });
      session.fromPartition('openkraken-providers').fetch = async (input, init) => {
        const url = new URL(String(input));
        if (
          url.origin !== 'https://api.github.com' ||
          new Headers(init?.headers).get('authorization') !== 'token fixture-pat'
        )
          throw new Error('Unexpected provider request');
        const json = (value: unknown, status = 200) =>
          new Response(JSON.stringify(value), {
            status,
            headers: { 'content-type': 'application/json' },
          });
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
        if (url.pathname === '/repos/team/project/pulls') return json([pull]);
        if (url.pathname === '/repos/team/project/pulls/1')
          return json({ ...pull, head: { ...pull.head, sha: state.head } });
        if (url.pathname === '/repos/team/project/pulls/1/files') {
          const extra = (i: number) => ({
            filename: `extra-${i}.txt`,
            status: 'added',
            additions: 1,
            deletions: 0,
            changes: 1,
            sha: '5'.repeat(40),
            patch: `+file ${i}`,
          });
          if (url.searchParams.get('page') === '2') return json([extra(100)]);
          return json([
            {
              filename: 'new.txt',
              previous_filename: 'old.txt',
              status: 'renamed',
              additions: 1,
              deletions: 1,
              changes: 2,
              sha: '4'.repeat(40),
              patch: '@@ -1 +1 @@\n-old\n+<img src="https://attacker.test/pixel">',
            },
            {
              filename: 'image.png',
              status: 'added',
              additions: 0,
              deletions: 0,
              changes: 0,
              sha: '5'.repeat(40),
            },
            ...Array.from({ length: 98 }, (_, i) => extra(i + 2)),
          ]);
        }
        if (url.pathname === '/repos/team/project/pulls/1/reviews') {
          if (init?.method === 'POST') {
            const body = JSON.parse(String(init.body)) as {
              event: string;
              body: string;
              commit_id: string;
            };
            state.posts.push(body);
            const review = {
              id: state.posts.length,
              user: { login: 'fixture-user' },
              state:
                body.event === 'APPROVE'
                  ? 'APPROVED'
                  : body.event === 'COMMENT'
                    ? 'COMMENTED'
                    : 'CHANGES_REQUESTED',
              body: body.body,
              commit_id: body.commit_id,
              submitted_at: '2026-10-03T00:00:00Z',
            };
            state.reviews.push(review);
            return state.uncertain ? json({ message: 'fixture-pat' }, 500) : json(review);
          }
          return json(state.reviews);
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
    await browser
      .getByRole('listbox', { name: 'Pull requests', exact: true })
      .getByRole('option')
      .click();
    const details = browser.getByRole('region', { name: 'Pull-request details' });
    await details.getByRole('button', { name: 'Files', exact: true }).click();
    await details.getByRole('option', { name: /renamed · new.txt/ }).click();
    await expect(details).toContainText('Previously: old.txt');
    const patch = details.getByLabel('Provider patch');
    await expect(patch).toContainText('<img src=');
    await expect(patch).toHaveAttribute('contenteditable', 'false');
    await expect(details.locator('img')).toHaveCount(0);
    await details.getByRole('option', { name: /added · image.png/ }).click();
    await expect(details).toContainText('No patch was supplied by the provider.');
    const files = details.getByRole('listbox', { name: 'Changed files' });
    expect(await files.getByRole('option').count()).toBeLessThan(20);
    await files.focus();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await expect(details.getByRole('region', { name: 'Selected file patch' })).toContainText(
      'extra-99.txt',
    );
    await details.getByRole('button', { name: 'Load more files' }).click();
    await expect(details.getByRole('status')).toContainText('101 files loaded');
    await files.focus();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await expect(details.getByRole('region', { name: 'Selected file patch' })).toContainText(
      '+file 100',
    );
    await details.getByRole('button', { name: 'Reviews', exact: true }).click();
    await expect(details.getByRole('status')).toContainText('0 reviews loaded');
    await details.getByRole('button', { name: 'Write review', exact: true }).click();
    const review = page.getByRole('dialog', { name: 'Write pull-request review' });
    await review.getByLabel('Review text').fill('Please add coverage.');
    await review.getByLabel('Review action').selectOption('REQUEST_CHANGES');
    await review.getByRole('button', { name: 'Close review', exact: true }).click();
    await expect(review.getByRole('region', { name: 'Discard review draft' })).toBeVisible();
    await review.getByRole('button', { name: 'Keep editing' }).click();
    await review.getByRole('button', { name: 'Preview review' }).click();
    await expect(review.getByRole('region', { name: 'Confirm review submission' })).toContainText(
      '1'.repeat(40),
    );
    const posts = () =>
      app.evaluate(
        () =>
          (globalThis as typeof globalThis & { reviewFixture: { posts: unknown[] } }).reviewFixture
            .posts,
      );
    expect(await posts()).toEqual([]);
    await app.evaluate(() => {
      (globalThis as typeof globalThis & { reviewFixture: { head: string } }).reviewFixture.head =
        '3'.repeat(40);
    });
    await review.getByRole('button', { name: 'Submit review', exact: true }).click();
    await expect(review.getByRole('alert')).toContainText('commits changed');
    expect(await posts()).toEqual([]);
    await expect(review.getByLabel('Review text')).toHaveValue('Please add coverage.');
    await review.getByRole('button', { name: 'Close review', exact: true }).click();
    await review.getByRole('button', { name: 'Discard draft' }).click();
    await details.getByRole('button', { name: 'Refresh details' }).click();
    await details.getByRole('button', { name: 'Write review', exact: true }).click();
    await review.getByLabel('Review text').fill('Reviewed the updated commit.');
    await review.getByLabel('Review action').selectOption('APPROVE');
    await review.getByRole('button', { name: 'Preview review' }).click();
    await review.getByRole('button', { name: 'Submit review', exact: true }).click();
    await expect(review.getByRole('status')).toContainText(
      `Review submitted for commit ${'3'.repeat(40)}`,
    );
    expect(await posts()).toEqual([
      { event: 'APPROVE', body: 'Reviewed the updated commit.', commit_id: '3'.repeat(40) },
    ]);
    await review.getByRole('button', { name: 'Close review', exact: true }).click();
    await expect(details.getByRole('list', { name: 'Reviews', exact: true })).toContainText(
      'fixture-user · APPROVED',
    );
    await app.evaluate(() => {
      (
        globalThis as typeof globalThis & { reviewFixture: { uncertain: boolean } }
      ).reviewFixture.uncertain = true;
    });
    await details.getByRole('button', { name: 'Write review', exact: true }).click();
    await review.getByLabel('Review text').fill('Follow-up <script>untrusted</script>');
    await review.getByRole('button', { name: 'Preview review' }).click();
    await review.getByRole('button', { name: 'Submit review', exact: true }).click();
    await expect(review.getByRole('alert')).toContainText('may have received');
    expect(await posts()).toHaveLength(2);
    await expect(review.getByRole('button', { name: 'Submit review', exact: true })).toHaveCount(0);
    await expect(review).not.toContainText('fixture-pat');
    await review.getByRole('button', { name: 'Check submitted reviews' }).click();
    await expect(review.getByRole('list', { name: 'Reviews', exact: true })).toContainText(
      'Follow-up <script>untrusted</script>',
    );
    await expect(review.locator('script')).toHaveCount(0);
    await page.screenshot({ path: 'test-results/provider-review-uncertain.png' });
    await review.getByRole('button', { name: 'I checked; return to draft' }).click();
    await expect(review.getByLabel('Review text')).toHaveValue(
      'Follow-up <script>untrusted</script>',
    );
    expect(await posts()).toHaveLength(2);
    await review.getByRole('button', { name: 'Close review', exact: true }).click();
    await review.getByRole('button', { name: 'Discard draft' }).click();
    await browser.getByRole('button', { name: 'Close', exact: true }).click();
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
