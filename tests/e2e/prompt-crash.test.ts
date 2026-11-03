import { _electron as electron, expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createFixture, fixtureGit } from '../../packages/test-fixtures/src/index.js';

test('a service crash retains unsaved native-editor text for copying and rejects stale replies', async () => {
  test.skip(process.platform === 'win32', 'POSIX pre-rebase hook fixture');
  const root = mkdtempSync(join(tmpdir(), 'openkraken-editor-crash-'));
  const repo = createFixture(join(root, 'repo'));
  fixtureGit(repo, ['branch', 'rebase-base']);
  fixtureGit(repo, ['commit', '--allow-empty', '-m', 'Review this commit']);
  const head = fixtureGit(repo, ['rev-parse', 'HEAD']);
  const document = join(repo, '.git/review-message.txt');
  writeFileSync(document, 'Original document\n');
  writeFileSync(
    join(repo, '.git/hooks/pre-rebase'),
    '#!/bin/sh\ndocument="$(git rev-parse --absolute-git-dir)/review-message.txt"\neval "$GIT_EDITOR \\"\\$document\\""\n',
    { mode: 0o755 },
  );
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, repo);
    await page.evaluate(() =>
      window.openkraken.subscribe((event) => {
        if (event.type === 'editorPrompt')
          Reflect.set(window, 'interruptedEditor', {
            requestId: event.id,
            promptId: event.promptId,
          });
      }),
    );
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    await page.getByRole('button', { name: 'Interactive rebase', exact: true }).click();
    const rebase = page.getByRole('dialog', { name: 'Plan interactive rebase' });
    await rebase
      .getByRole('combobox', { name: 'Rebase base' })
      .selectOption({ label: 'rebase-base' });
    await rebase.getByRole('button', { name: 'Review commits' }).click();
    await rebase.getByRole('button', { name: 'Start reviewed rebase' }).click();
    const editor = page.getByRole('dialog', { name: 'Git document editor' });
    await editor
      .getByRole('textbox', { name: 'Document text' })
      .fill('Unsaved text retained for copying\n');
    await app.evaluate(({ app }) => {
      const service = app.getAppMetrics().find((metric) => metric.name === 'OpenKraken Git');
      if (!service) throw new Error('Missing Git service');
      process.kill(service.pid, 'SIGKILL');
    });
    await expect(editor.getByRole('alert')).toContainText(
      'Copy your text before discarding this draft',
    );
    await expect(editor.getByRole('textbox', { name: 'Document text' })).toHaveValue(
      'Unsaved text retained for copying\n',
    );
    await expect(editor.getByRole('button', { name: 'Save and continue' })).toHaveCount(0);
    await page.screenshot({ path: 'test-results/interrupted-native-editor.png' });
    await editor.press('Escape');
    await expect(editor).toBeVisible();
    await app.evaluate(({ dialog, BrowserWindow }) => {
      Reflect.set(globalThis, 'draftClosePrompted', false);
      dialog.showMessageBoxSync = () => {
        Reflect.set(globalThis, 'draftClosePrompted', true);
        return 0;
      };
      BrowserWindow.getAllWindows()[0]!.close();
    });
    await expect
      .poll(() => app.evaluate(() => Reflect.get(globalThis, 'draftClosePrompted')))
      .toBe(true);
    await expect(editor.getByRole('textbox', { name: 'Document text' })).toHaveValue(
      'Unsaved text retained for copying\n',
    );
    expect(readFileSync(document, 'utf8')).toBe('Original document\n');
    expect(fixtureGit(repo, ['rev-parse', 'HEAD'])).toBe(head);
    expect(
      await page.evaluate(() =>
        window.openkraken.request({
          id: crypto.randomUUID(),
          method: 'answerEditor',
          ...Reflect.get(window, 'interruptedEditor'),
          text: 'Stale reply',
        }),
      ),
    ).toMatchObject({ kind: 'editorAnswered', accepted: false });
    expect(readFileSync(document, 'utf8')).toBe('Original document\n');
    await editor.getByRole('button', { name: 'Discard unsaved draft', exact: true }).click();
    await expect(editor).toHaveCount(0);
    await expect(rebase.getByRole('alert')).toContainText(
      'Inspect the repository or remote before retrying',
    );
  } finally {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBoxSync = () => 1;
    });
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a service crash dismisses native authentication and a replacement service rejects its stale secret', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-auth-crash-'));
  const target = join(root, 'target');
  mkdirSync(target);
  const authorizations: (string | undefined)[] = [];
  const server = createServer((request, response) => {
    authorizations.push(request.headers.authorization);
    response.writeHead(401, { 'www-authenticate': 'Basic realm="OpenKraken crash fixture"' });
    response.end('Authentication required');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing listener');
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, target);
    await page.evaluate(() =>
      window.openkraken.subscribe((event) => {
        if (event.type === 'authenticationPrompt')
          Reflect.set(window, 'interruptedAuth', { requestId: event.id, promptId: event.promptId });
      }),
    );
    await page.getByRole('button', { name: 'Clone', exact: true }).click();
    const clone = page.getByRole('dialog', { name: 'Clone repository', exact: true });
    await clone
      .getByRole('textbox', { name: 'Repository URL or absolute path', exact: true })
      .fill(`http://127.0.0.1:${address.port}/repo.git`);
    await clone.getByRole('button', { name: 'Choose folder and clone', exact: true }).click();
    const auth = page.getByRole('dialog', { name: 'Git authentication', exact: true });
    await auth.getByLabel('Username', { exact: true }).fill('fixture-user');
    await auth.getByRole('button', { name: 'Continue', exact: true }).click();
    await auth.getByLabel('Password or passphrase', { exact: true }).fill('secret-not-submitted');
    await app.evaluate(({ app }) => {
      const service = app.getAppMetrics().find((metric) => metric.name === 'OpenKraken Git');
      if (!service) throw new Error('Missing Git service');
      process.kill(service.pid, 'SIGKILL');
    });
    await expect(auth).toHaveCount(0);
    await expect(clone.getByRole('alert')).toContainText(
      'Inspect the repository or remote before retrying',
    );
    expect(
      await page.evaluate(() =>
        window.openkraken.request({
          id: crypto.randomUUID(),
          method: 'answerPrompt',
          ...Reflect.get(window, 'interruptedAuth'),
          answer: 'secret-not-submitted',
        }),
      ),
    ).toMatchObject({ kind: 'authenticationAnswered', accepted: false });
    expect(authorizations.length).toBeGreaterThan(0);
    expect(authorizations.every((value) => value === undefined)).toBe(true);
    expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(
      'secret-not-submitted',
    );
  } finally {
    await app.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
