import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createFixture, fixtureGit } from '../../packages/test-fixtures/src/index.js';

for (const scenario of [
  'partial choices',
  'manual output',
  'changed file',
  'aborted merge',
  'changed draft storage',
]) {
  test(`conflict recovery after app death with ${scenario}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'ok-conflict-draft-'));
    const path = createFixture(join(root, 'repo'));
    const file = join(path, 'tracked.txt');
    const content = (side: string) =>
      [
        side + ' first',
        'keep',
        'middle',
        'anchor',
        'separate',
        'keep again',
        side + ' last',
        '',
      ].join('\n');
    writeFileSync(file, content('base'));
    fixtureGit(path, ['commit', '-am', 'set up two chunks']);
    fixtureGit(path, ['switch', '-c', 'incoming']);
    writeFileSync(file, content('theirs'));
    fixtureGit(path, ['commit', '-am', 'incoming']);
    fixtureGit(path, ['switch', 'main']);
    writeFileSync(file, content('ours'));
    fixtureGit(path, ['commit', '-am', 'main']);
    expect(() => fixtureGit(path, ['merge', 'incoming'])).toThrow();
    const originalFile = readFileSync(file, 'utf8');
    const index = () => fixtureGit(path, ['ls-files', '-u']);
    const originalStages = index();
    const args = [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`];
    let app = await electron.launch({ args });
    const open = async () => {
      const page = await app.firstWindow();
      await app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
      }, path);
      await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
      return page;
    };
    try {
      let page = await open();
      await page.getByRole('button', { name: 'Resolve tracked.txt', exact: true }).click();
      let dialog = page.getByRole('dialog', { name: 'Resolve tracked.txt' });
      if (scenario === 'partial choices') {
        await dialog.getByRole('button', { name: 'Use chunk editor' }).click();
        const first = dialog.locator('fieldset').first();
        await first.getByText('Choose individual lines').click();
        await first.getByRole('checkbox', { name: /ours line 1$/ }).check();
        await expect(dialog.getByText('1 chunk needs a choice.')).toBeVisible();
      } else
        await dialog
          .getByRole('textbox', { name: 'Output', exact: true })
          .fill('reviewed manual output\n');
      await expect(dialog.getByText('Draft saved locally')).toBeVisible();
      const output = await dialog
        .getByRole('textbox', { name: 'Output', exact: true })
        .inputValue();
      expect(index()).toBe(originalStages);
      expect(readFileSync(file, 'utf8')).toBe(originalFile);
      if (scenario === 'changed file') {
        writeFileSync(file, 'external change\n');
        await dialog.getByRole('button', { name: 'Save and stage output' }).click();
        await expect(dialog.getByRole('alert')).toContainText('conflict changed');
        await expect(dialog.getByRole('textbox', { name: 'Output', exact: true })).toHaveValue(
          output,
        );
        expect(index()).toBe(originalStages);
      }
      const process = app.process(),
        exited = once(process, 'exit');
      expect(process.kill('SIGKILL')).toBe(true);
      await exited;
      if (scenario === 'aborted merge') fixtureGit(path, ['merge', '--abort']);
      app = await electron.launch({ args });
      page = await open();
      if (scenario === 'aborted merge') {
        await page.getByRole('button', { name: 'Saved file drafts', exact: true }).click();
        const drafts = page.getByRole('dialog', { name: 'Saved file drafts' });
        await drafts
          .getByRole('button', { name: 'tracked.txt (conflict resolution)', exact: true })
          .click();
        await expect(drafts.getByRole('textbox', { name: 'Recovered file text' })).toHaveValue(
          output,
        );
        await drafts.getByRole('button', { name: 'Discard draft' }).click();
        await drafts.getByRole('button', { name: 'Confirm discard' }).click();
        await expect(drafts.getByText('No saved file drafts for this checkout.')).toBeVisible();
        expect(readFileSync(file, 'utf8')).toBe(content('ours'));
        return;
      }
      await page.getByRole('button', { name: 'Resolve tracked.txt', exact: true }).click();
      dialog = page.getByRole('dialog', { name: 'Resolve tracked.txt' });
      await expect(dialog.getByText('Recovered conflict draft')).toBeVisible();
      await expect(dialog.getByRole('textbox', { name: 'Output', exact: true })).toHaveValue(
        output,
      );
      expect(index()).toBe(originalStages);
      const stage = dialog.getByRole('button', { name: 'Save and stage output' });
      if (scenario === 'changed draft storage') {
        const folder = join(root, 'profile', 'conflict-drafts');
        const [stored] = readdirSync(folder);
        const draftFile = join(folder, stored!);
        const external = readFileSync(draftFile, 'utf8') + '\n';
        writeFileSync(draftFile, external);
        const text = dialog.getByRole('textbox', { name: 'Output', exact: true });
        await text.fill('newer text still in the editor');
        await dialog.getByRole('button', { name: 'Close', exact: true }).click();
        await expect(dialog.getByRole('alert')).toContainText('changed elsewhere');
        await expect(text).toHaveValue('newer text still in the editor');
        await dialog
          .getByRole('button', { name: 'Close without changing the saved draft' })
          .click();
        await expect(dialog).toHaveCount(0);
        expect(readFileSync(draftFile, 'utf8')).toBe(external);
        expect(readFileSync(file, 'utf8')).toBe(originalFile);
        expect(index()).toBe(originalStages);
        return;
      }
      if (scenario === 'changed file') {
        await expect(stage).toBeDisabled();
        const recovered = dialog.getByRole('textbox', { name: 'Output', exact: true });
        await expect(recovered).toBeEnabled();
        await expect(recovered).not.toBeEditable();
        await expect(dialog.getByRole('button', { name: 'Use ours and stage' })).toBeDisabled();
        await expect(dialog.getByRole('alert')).toContainText('conflict changed');
        await dialog.getByRole('button', { name: 'Discard conflict draft' }).click();
        await dialog.getByRole('button', { name: 'Confirm discard' }).click();
        await expect(dialog).toHaveCount(0);
        expect(readFileSync(file, 'utf8')).toBe('external change\n');
        expect(index()).toBe(originalStages);
        return;
      }
      if (scenario === 'partial choices') {
        await expect(stage).toBeDisabled();
        const first = dialog.locator('fieldset').first();
        await first.getByText('Choose individual lines').click();
        await expect(first.getByRole('checkbox', { name: /ours line 1$/ })).toBeChecked();
        await dialog
          .locator('fieldset')
          .last()
          .getByRole('button', { name: /Take theirs for chunk/ })
          .click();
      }
      if (scenario === 'manual output') {
        await dialog
          .getByRole('textbox', { name: 'Output', exact: true })
          .fill('latest edit before close\n');
        await dialog.getByRole('button', { name: 'Close', exact: true }).click();
        await expect(dialog).toHaveCount(0);
        await page.getByRole('button', { name: 'Resolve tracked.txt', exact: true }).click();
        await expect(dialog.getByRole('textbox', { name: 'Output', exact: true })).toHaveValue(
          'latest edit before close\n',
        );
      }
      const resolved = await dialog
        .getByRole('textbox', { name: 'Output', exact: true })
        .inputValue();
      await stage.click();
      await expect(dialog).toHaveCount(0);
      expect(index()).toBe('');
      expect(readFileSync(file, 'utf8')).toBe(resolved);
      expect(fixtureGit(path, ['show', ':tracked.txt'])).toBe(resolved.trimEnd());
      await page.getByRole('button', { name: 'Saved file drafts', exact: true }).click();
      await expect(page.getByText('No saved file drafts for this checkout.')).toBeVisible();
    } finally {
      if (app.process().signalCode === null && app.process().exitCode === null) {
        await app.evaluate(({ dialog }) => {
          dialog.showMessageBoxSync = () => 1;
        });
        await app.close();
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
}
