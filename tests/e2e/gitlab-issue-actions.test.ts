import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fixtureProtection } from './provider-fixtures.js';
import { gitlabIssueFixture, gitlabIssueNoteFixture } from '../gitlab-fixtures.js';

test('GitLab issue actions review native visibility, preserve stale drafts and inspect uncertain comments without retrying', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-gitlab-issue-actions-ui-'));
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    await fixtureProtection(app);
    await app.evaluate(
      ({ session }, { issue, note }) => {
        const state = {
          issues: [issue],
          notes: [] as (typeof note)[],
          writes: [] as unknown[],
          uncertain: false,
          blocked: false,
          started: false,
        };
        Object.assign(globalThis, { gitlabIssueActions: state });
        session.fromPartition('openkraken-providers').fetch = async (input, init) => {
          const url = new URL(String(input));
          if (
            url.origin !== 'https://gitlab.com' ||
            new Headers(init?.headers).get('authorization') !== 'Bearer action-secret'
          )
            throw new Error('Unexpected provider request');
          if (url.pathname === '/api/v4/user')
            return Response.json({ id: 73, username: 'fixture-user' });
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
          if (url.pathname === '/api/v4/projects/group%2Fsubgroup%2Fproject') {
            if (state.blocked) {
              state.started = true;
              await new Promise<void>((resolve) => {
                if (init?.signal?.aborted) resolve();
                else init?.signal?.addEventListener('abort', () => resolve(), { once: true });
              });
            }
            return Response.json({
              id: 77,
              path_with_namespace: 'group/subgroup/project',
              archived: false,
              issues_enabled: true,
              issues_access_level: 'enabled',
            });
          }
          const match = /^\/api\/v4\/projects\/77\/issues(?:\/(\d+))?(\/notes)?$/.exec(
            url.pathname,
          );
          if (!match) throw new Error('Unexpected endpoint');
          const number = Number(match[1]);
          const current = state.issues.find((item) => item.iid === number);
          if (init?.method === 'POST' || init?.method === 'PUT') {
            const body = JSON.parse(String(init.body)) as {
              title?: string;
              description?: string;
              confidential?: boolean;
              body?: string;
              internal?: boolean;
              state_event?: string;
            };
            state.writes.push({ method: init.method, path: url.pathname, body });
            if (!match[1]) {
              const created = {
                ...issue,
                iid: 8,
                id: 2008,
                issue_type: 'issue',
                title: body.title!,
                description: body.description!,
                confidential: body.confidential!,
              };
              state.issues.push(created);
              return Response.json(created, { status: 201 });
            }
            if (match[2]) {
              const created = {
                ...note,
                id: 41,
                body: body.body!,
                internal: body.internal!,
                confidential: body.internal!,
                noteable_id: 2008,
                noteable_iid: 8,
                type: 'Note',
              };
              state.notes.push(created);
              return state.uncertain
                ? Response.json({ message: 'action-secret' }, { status: 503 })
                : Response.json(created, { status: 201 });
            }
            current!.state = body.state_event === 'close' ? 'closed' : 'opened';
            return Response.json(current);
          }
          if (!match[1])
            return Response.json(
              state.issues.filter(
                (item) =>
                  !url.searchParams.get('state') || item.state === url.searchParams.get('state'),
              ),
            );
          if (match[2]) return Response.json(state.notes);
          return Response.json(current);
        };
      },
      { issue: gitlabIssueFixture(7), note: gitlabIssueNoteFixture() },
    );
    const page = await app.firstWindow();
    await page.evaluate(() =>
      window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'providerConnect',
        options: { provider: 'gitlab', origin: 'https://gitlab.com', token: 'action-secret' },
      }),
    );
    await page.getByRole('button', { name: 'Issues', exact: true }).click();
    const browser = page.getByRole('dialog', { name: 'Browse issues' });
    await browser
      .getByRole('option', { name: 'Select group/subgroup/project', exact: true })
      .click();
    await browser.getByRole('button', { name: 'New issue', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Issue action', exact: true });
    await dialog
      .getByRole('textbox', { name: 'Issue title', exact: true })
      .fill('Created from desktop');
    await dialog
      .getByRole('textbox', { name: 'Description', exact: true })
      .fill('Literal <script>description</script>');
    await dialog.getByRole('checkbox', { name: 'Confidential issue', exact: true }).check();
    await dialog.getByRole('button', { name: 'Review issue action', exact: true }).click();
    await expect(dialog.getByRole('region', { name: 'Confirm issue action' })).toContainText(
      'Confidential issue',
    );
    await expect(dialog.getByRole('textbox', { name: 'Issue title', exact: true })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Confirm issue action', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('Created issue #8');
    await dialog.getByRole('button', { name: 'Close action', exact: true }).click();
    await browser
      .getByRole('option', { name: 'Open issue #8: Created from desktop', exact: true })
      .click();
    const detail = browser.getByRole('region', { name: 'Issue details', exact: true });
    await detail.getByRole('button', { name: 'Write issue comment', exact: true }).click();
    await dialog
      .getByRole('textbox', { name: 'Comment', exact: true })
      .fill('Exact <script>comment</script>');
    await dialog.getByRole('checkbox', { name: 'Internal note', exact: true }).check();
    await dialog.getByRole('button', { name: 'Review issue action', exact: true }).click();
    await expect(dialog.getByRole('region', { name: 'Confirm issue action' })).toContainText(
      'Internal note',
    );
    await app.evaluate(() => {
      (
        globalThis as typeof globalThis & {
          gitlabIssueActions: { issues: { iid: number; title: string }[] };
        }
      ).gitlabIssueActions.issues.find((item) => item.iid === 8)!.title = 'Changed issue';
    });
    await dialog.getByRole('button', { name: 'Confirm issue action', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('changed');
    await expect(dialog.getByRole('textbox', { name: 'Comment', exact: true })).toHaveValue(
      'Exact <script>comment</script>',
    );
    await dialog.getByRole('button', { name: 'Review issue action', exact: true }).click();
    await app.evaluate(() => {
      (
        globalThis as typeof globalThis & { gitlabIssueActions: { uncertain: boolean } }
      ).gitlabIssueActions.uncertain = true;
    });
    await dialog.getByRole('button', { name: 'Confirm issue action', exact: true }).click();
    const uncertain = dialog.getByRole('region', { name: 'Uncertain issue action' });
    await expect(uncertain).toBeVisible();
    await uncertain.getByRole('button', { name: 'Check existing results', exact: true }).click();
    await dialog
      .getByRole('region', { name: 'Existing results' })
      .getByText('#41 · reviewer', { exact: false })
      .click();
    await expect(dialog.getByRole('region', { name: 'Existing results' })).toContainText(
      'Exact <script>comment</script>',
    );
    await expect(dialog).not.toContainText('action-secret');
    expect(
      await app.evaluate(
        () =>
          (globalThis as typeof globalThis & { gitlabIssueActions: { writes: unknown[] } })
            .gitlabIssueActions.writes.length,
      ),
    ).toBe(2);
    await dialog.getByRole('button', { name: 'Close action', exact: true }).click();
    await dialog.getByRole('button', { name: 'Keep draft', exact: true }).click();
    await expect(dialog.getByRole('textbox', { name: 'Comment', exact: true })).toHaveValue(
      'Exact <script>comment</script>',
    );
    await dialog.getByRole('button', { name: 'Close action', exact: true }).click();
    await dialog.getByRole('button', { name: 'Discard draft', exact: true }).click();
    await detail.getByRole('button', { name: 'Close issue', exact: true }).click();
    await expect(dialog.getByRole('combobox', { name: 'Closing reason', exact: true })).toHaveCount(
      0,
    );
    await dialog.getByRole('button', { name: 'Review issue action', exact: true }).click();
    await dialog.getByRole('button', { name: 'Confirm issue action', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('now closed');
    await dialog.getByRole('button', { name: 'Close action', exact: true }).click();
    await browser.getByLabel('Issue state', { exact: true }).selectOption('closed');
    await browser
      .getByRole('option', { name: 'Open issue #8: Changed issue', exact: true })
      .click();
    await detail.getByRole('button', { name: 'Reopen issue', exact: true }).click();
    await app.evaluate(() => {
      (
        globalThis as typeof globalThis & { gitlabIssueActions: { blocked: boolean } }
      ).gitlabIssueActions.blocked = true;
    });
    await dialog.getByRole('button', { name: 'Review issue action', exact: true }).click();
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (globalThis as typeof globalThis & { gitlabIssueActions: { started: boolean } })
              .gitlabIssueActions.started,
        ),
      )
      .toBe(true);
    await dialog.getByRole('button', { name: 'Cancel request', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('cancelled');
    await app.evaluate(() => {
      (
        globalThis as typeof globalThis & { gitlabIssueActions: { blocked: boolean } }
      ).gitlabIssueActions.blocked = false;
    });
    await dialog.getByRole('button', { name: 'Review issue action', exact: true }).click();
    await dialog.getByRole('button', { name: 'Confirm issue action', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('now open');
    expect(
      await app.evaluate(
        () =>
          (globalThis as typeof globalThis & { gitlabIssueActions: { writes: unknown[] } })
            .gitlabIssueActions.writes.length,
      ),
    ).toBe(4);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
