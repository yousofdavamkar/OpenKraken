import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fixtureProtection } from './provider-fixtures.js';
import {
  githubCommentFixture,
  githubPullFixture,
} from '../../packages/test-fixtures/src/provider.js';

test('inline review comments map patch lines, group replies and preserve uncertain drafts without duplicate writes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-comments-ui-'));
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    await fixtureProtection(app);
    await app.evaluate(
      ({ session }, fixtures) => {
        const { pull, comment } = fixtures;
        const state = {
          posts: [] as unknown[],
          uncertain: false,
          blocked: false,
          started: false,
          aborted: false,
          comments: [
            comment,
            {
              ...comment,
              id: 11,
              in_reply_to_id: 10,
              line: null,
              original_line: 2,
              body: '<img src="https://attacker.test"> old reply',
            },
          ] as unknown[],
        };
        Object.assign(globalThis, { commentFixture: state });
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
          if (url.pathname === '/repos/team/project/pulls') return json([pull]);
          if (url.pathname === '/repos/team/project/pulls/1') return json(pull);
          if (url.pathname === '/repos/team/project/pulls/1/files')
            return json([
              {
                filename: 'src/main.ts',
                status: 'modified',
                additions: 2,
                deletions: 2,
                changes: 4,
                sha: '4'.repeat(40),
                patch:
                  '@@ -2,2 +2,2 @@\n-old\n+new\n context\n@@ -40 +50 @@\n-late old\n+late new\n\\ No newline at end of file',
              },
            ]);
          if (url.pathname === '/repos/team/project/pulls/comments/10') return json(comment);
          if (url.pathname === '/repos/team/project/pulls/1/comments' && init?.method !== 'POST') {
            if (state.blocked) {
              state.started = true;
              await new Promise<void>((resolve) => {
                if (init?.signal?.aborted) resolve();
                else init?.signal?.addEventListener('abort', () => resolve(), { once: true });
              });
              state.aborted = true;
            }
            return json(state.comments);
          }
          if (
            init?.method === 'POST' &&
            (url.pathname === '/repos/team/project/pulls/1/comments' ||
              url.pathname === '/repos/team/project/pulls/1/comments/10/replies')
          ) {
            const body = JSON.parse(String(init.body)) as {
              body: string;
              line?: number;
              side?: string;
            };
            state.posts.push({ endpoint: url.pathname, ...body });
            const created = {
              ...comment,
              id: 200 + state.posts.length,
              body: body.body,
              ...(body.line ? { line: body.line, side: body.side } : { in_reply_to_id: 10 }),
            };
            state.comments.push(created);
            return state.uncertain ? json({ message: 'fixture-pat' }, 500) : json(created, 201);
          }
          throw new Error('Unexpected endpoint');
        };
      },
      { pull: githubPullFixture(), comment: githubCommentFixture() },
    );
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
    await details.getByRole('button', { name: 'Comments', exact: true }).click();
    await expect(details.getByRole('status')).toContainText('2 comments loaded');
    const threads = details.getByRole('list', { name: 'Comment threads' });
    await expect(threads).toContainText('Outdated · original line 2');
    await expect(threads).toContainText('<img src=');
    await expect(threads.locator('img')).toHaveCount(0);
    await threads.getByRole('button', { name: 'Reply to thread #10', exact: true }).last().click();
    const composer = page.getByRole('dialog', { name: 'Write inline comment' });
    await expect(composer).toContainText('Reply to thread #10');
    await composer.getByLabel('Comment text').fill('Explained in the next commit.');
    await composer.getByRole('button', { name: 'Preview comment' }).click();
    const posts = () =>
      app.evaluate(
        () =>
          (globalThis as typeof globalThis & { commentFixture: { posts: unknown[] } })
            .commentFixture.posts,
      );
    expect(await posts()).toEqual([]);
    await composer.getByRole('button', { name: 'Submit comment', exact: true }).click();
    await expect(composer.getByRole('status')).toContainText('Comment submitted');
    expect(await posts()).toEqual([
      {
        endpoint: '/repos/team/project/pulls/1/comments/10/replies',
        body: 'Explained in the next commit.',
      },
    ]);
    await composer.getByRole('button', { name: 'Close comment' }).click();
    await expect(details.getByRole('status')).toContainText('3 comments loaded');
    await details.getByRole('button', { name: 'Files', exact: true }).click();
    await details.getByRole('option', { name: /modified · src\/main.ts/ }).click();
    const patch = details.getByLabel('Provider patch');
    await patch
      .locator('.cm-line')
      .filter({ hasText: /^-old$/ })
      .click();
    await expect(details).toContainText('Selected old line 2');
    await patch
      .locator('.cm-line')
      .filter({ hasText: /^\+late new$/ })
      .click();
    await expect(details).toContainText('Selected new line 50');
    await details.getByRole('button', { name: 'Comment on selected line' }).click();
    await expect(composer).toContainText('src/main.ts · RIGHT line 50');
    await composer.getByLabel('Comment text').fill('Explain this later hunk.');
    await composer.getByRole('button', { name: 'Close comment' }).click();
    await expect(composer.getByRole('region', { name: 'Discard comment draft' })).toBeVisible();
    await composer.getByRole('button', { name: 'Keep editing' }).click();
    await composer.getByRole('button', { name: 'Preview comment' }).click();
    await composer.getByRole('button', { name: 'Submit comment', exact: true }).click();
    await expect(composer.getByRole('status')).toContainText('Comment submitted');
    expect((await posts())[1]).toEqual({
      endpoint: '/repos/team/project/pulls/1/comments',
      body: 'Explain this later hunk.',
      commit_id: '1'.repeat(40),
      line: 50,
      side: 'RIGHT',
      path: 'src/main.ts',
    });
    await composer.getByRole('button', { name: 'Close comment' }).click();
    await patch
      .locator('.cm-line')
      .filter({ hasText: /^\\ No newline/ })
      .click();
    await expect(details.getByRole('button', { name: 'Comment on selected line' })).toHaveCount(0);
    await details.getByRole('button', { name: 'Comments', exact: true }).click();
    await expect(details.getByRole('status')).toContainText('4 comments loaded');
    await threads.getByRole('button', { name: 'Reply to thread #10', exact: true }).first().click();
    await composer.getByLabel('Comment text').fill('Reply with uncertain acknowledgment.');
    await app.evaluate(() => {
      (
        globalThis as typeof globalThis & { commentFixture: { uncertain: boolean } }
      ).commentFixture.uncertain = true;
    });
    await composer.getByRole('button', { name: 'Preview comment' }).click();
    await composer.getByRole('button', { name: 'Submit comment', exact: true }).click();
    await expect(composer.getByRole('alert')).toContainText('may have received');
    await expect(composer).not.toContainText('fixture-pat');
    await composer.getByRole('button', { name: 'Check submitted comments' }).click();
    await expect(composer.getByRole('status')).toContainText('5 comments loaded');
    const uncertainThreads = composer.getByRole('list', { name: 'Comment threads' });
    await uncertainThreads.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(uncertainThreads).toContainText('Reply with uncertain acknowledgment.');
    await page.screenshot({ path: 'test-results/provider-inline-comments.png' });
    await composer.getByRole('button', { name: 'I checked; return to draft' }).click();
    await expect(composer.getByLabel('Comment text')).toHaveValue(
      'Reply with uncertain acknowledgment.',
    );
    expect(await posts()).toHaveLength(3);
    await composer.getByRole('button', { name: 'Close comment' }).click();
    await composer.getByRole('button', { name: 'Discard draft' }).click();
    await app.evaluate(() => {
      (
        globalThis as typeof globalThis & { commentFixture: { blocked: boolean } }
      ).commentFixture.blocked = true;
    });
    await details.getByRole('button', { name: 'Refresh comments' }).click();
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (globalThis as typeof globalThis & { commentFixture: { started: boolean } })
              .commentFixture.started,
        ),
      )
      .toBe(true);
    await browser.getByRole('button', { name: 'Close', exact: true }).click();
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (globalThis as typeof globalThis & { commentFixture: { aborted: boolean } })
              .commentFixture.aborted,
        ),
      )
      .toBe(true);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
