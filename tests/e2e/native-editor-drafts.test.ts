import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createFixture, fixtureGit } from '../../packages/test-fixtures/src/index.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ok-git-document-recovery-'));
  const repo = createFixture(join(root, 'repo'));
  fixtureGit(repo, ['branch', 'rebase-base']);
  fixtureGit(repo, ['commit', '--allow-empty', '-m', 'Review this commit']);
  const document = join(repo, '.git', 'review-message.txt');
  writeFileSync(document, 'Original document\n');
  writeFileSync(
    join(repo, '.git', 'hooks', 'pre-rebase'),
    '#!/bin/sh\ndocument="$(git rev-parse --absolute-git-dir)/review-message.txt"\neval "$GIT_EDITOR \\"\\$document\\""\n',
    { mode: 0o755 },
  );
  return {
    root,
    repo,
    document,
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  };
}
async function open(app: ElectronApplication, repo: string) {
  const page = await app.firstWindow();
  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
  }, repo);
  await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
  return page;
}
async function prompt(page: Page) {
  await page.getByRole('button', { name: 'Interactive rebase', exact: true }).click();
  const plan = page.getByRole('dialog', { name: 'Plan interactive rebase' });
  await plan.getByRole('combobox', { name: 'Rebase base' }).selectOption({ label: 'rebase-base' });
  await plan.getByRole('button', { name: 'Review commits' }).click();
  await plan.getByRole('button', { name: 'Start reviewed rebase' }).click();
  const editor = page.getByRole('dialog', { name: 'Git document editor' });
  await expect(editor).toBeVisible();
  return { editor, plan };
}
async function quit(app: ElectronApplication) {
  if (app.process().signalCode !== null || app.process().exitCode !== null) return;
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBoxSync = () => 1;
  });
  await app.close();
}
for (const scenario of [
  'main-process death',
  'retry with identical source',
  'retry with changed source',
]) {
  const changed = scenario === 'retry with changed source';
  test(`native editor recovery after ${scenario}`, async () => {
    test.skip(process.platform === 'win32', 'POSIX pre-rebase hook fixture');
    const { root, repo, document, args } = fixture();
    const head = fixtureGit(repo, ['rev-parse', 'HEAD']);
    let app = await electron.launch({ args });
    try {
      let page = await open(app, repo);
      await page.evaluate(() =>
        window.openkraken.subscribe((event) => {
          if (event.type === 'editorPrompt')
            window.document.documentElement.dataset.gitOperation = event.id;
        }),
      );
      let { editor } = await prompt(page);
      const saved = 'Unsubmitted reviewed text\n';
      await editor.getByRole('textbox', { name: 'Document text' }).fill(saved);
      await expect(editor.getByText('Draft saved locally', { exact: true })).toBeVisible();
      if (scenario === 'main-process death') {
        const main = app.process(),
          exited = once(main, 'exit');
        expect(main.kill('SIGKILL')).toBe(true);
        await exited;
      } else {
        await page.evaluate(() =>
          window.openkraken.cancel(window.document.documentElement.dataset.gitOperation!),
        );
        await expect(editor).toHaveCount(0);
        await expect.poll(() => existsSync(join(repo, '.git', 'index.lock'))).toBe(false);
        await quit(app);
      }
      expect(readFileSync(document, 'utf8')).toBe('Original document\n');
      expect(fixtureGit(repo, ['rev-parse', 'HEAD'])).toBe(head);
      const source = changed ? 'Independent edit\n' : 'Original document\n';
      if (changed) writeFileSync(document, source);
      app = await electron.launch({ args });
      page = await open(app, repo);
      await page.getByRole('button', { name: 'Saved file drafts', exact: true }).click();
      const inventory = page.getByRole('dialog', { name: 'Saved file drafts' });
      await inventory.getByRole('button', { name: /review-message\.txt \(Git editor/ }).click();
      await expect(inventory.getByRole('textbox', { name: 'Recovered file text' })).toHaveValue(
        saved,
      );
      if (scenario === 'main-process death') {
        await inventory.getByRole('button', { name: 'Discard draft', exact: true }).click();
        await inventory.getByRole('button', { name: 'Confirm discard', exact: true }).click();
        await expect(inventory.getByText('No saved file drafts for this checkout.')).toBeVisible();
        expect(readFileSync(document, 'utf8')).toBe(source);
        expect(fixtureGit(repo, ['rev-parse', 'HEAD'])).toBe(head);
        return;
      }
      await inventory.getByRole('button', { name: 'Close', exact: true }).click();
      const next = await prompt(page);
      editor = next.editor;
      const text = editor.getByRole('textbox', { name: 'Document text' });
      await expect(text).toHaveValue(source);
      await editor.getByText('Earlier drafts for this document', { exact: true }).click();
      await editor.getByRole('combobox', { name: 'Saved draft' }).selectOption({ index: 1 });
      await expect(editor.getByRole('textbox', { name: 'Earlier Git editor text' })).toHaveValue(
        saved,
      );
      const copy = editor.getByRole('button', { name: 'Use a copy of this draft' });
      if (changed) {
        await expect(copy).toHaveCount(0);
        await expect(
          editor.getByText('The starting document has changed.', { exact: false }),
        ).toBeVisible();
        await text.fill('Cancel this new edit');
        await expect(editor.getByText('Draft saved locally')).toBeVisible();
        await editor.getByRole('button', { name: 'Cancel edit' }).click();
      } else {
        await copy.click();
        await expect(text).toHaveValue(saved);
        expect(readFileSync(document, 'utf8')).toBe(source);
        await editor.getByRole('button', { name: 'Save and continue' }).click();
      }
      await expect(editor).toHaveCount(0);
      await expect.poll(() => readFileSync(document, 'utf8')).toBe(changed ? source : saved);
      await expect
        .poll(() =>
          readdirSync(join(root, 'profile', 'native-editor-drafts')).filter((name) =>
            name.endsWith('.json'),
          ),
        )
        .toHaveLength(1);
      if (changed) await next.plan.getByRole('button', { name: 'Close', exact: true }).click();
      else await expect(next.plan).toHaveCount(0);
      await page.getByRole('button', { name: 'Saved file drafts', exact: true }).click();
      await inventory.getByRole('button', { name: /review-message\.txt \(Git editor/ }).click();
      await inventory.getByRole('button', { name: 'Discard draft', exact: true }).click();
      await inventory.getByRole('button', { name: 'Confirm discard', exact: true }).click();
      await expect(inventory.getByText('No saved file drafts for this checkout.')).toBeVisible();
    } finally {
      await quit(app);
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('a Git editor answer refused at the document write retains its recovery copy', async () => {
  test.skip(process.platform === 'win32', 'POSIX pre-rebase hook fixture');
  const { root, repo, document, args } = fixture(),
    app = await electron.launch({ args });
  try {
    const page = await open(app, repo),
      { editor, plan } = await prompt(page);
    await editor
      .getByRole('textbox', { name: 'Document text' })
      .fill('Recovery after refused write\n');
    writeFileSync(document, 'Another process wrote this\n');
    await editor.getByRole('button', { name: 'Save and continue' }).click();
    await expect(editor).toHaveCount(0);
    await expect(plan.getByRole('alert')).toBeVisible();
    expect(readFileSync(document, 'utf8')).toBe('Another process wrote this\n');
    await plan.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'Saved file drafts', exact: true }).click();
    const inventory = page.getByRole('dialog', { name: 'Saved file drafts' });
    await inventory.getByRole('button', { name: /review-message\.txt \(Git editor/ }).click();
    await expect(inventory.getByRole('textbox', { name: 'Recovered file text' })).toHaveValue(
      'Recovery after refused write\n',
    );
  } finally {
    await quit(app);
    rmSync(root, { recursive: true, force: true });
  }
});
