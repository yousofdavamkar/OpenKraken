import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createFixture } from '../../packages/test-fixtures/src/index.js';

for (const changed of [false, true]) {
  test(`working draft survives app death when the underlying file is ${changed ? 'changed' : 'unchanged'}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'openkraken-file-recovery-'));
    const repo = createFixture(join(root, 'repo'));
    const file = join(repo, 'draft.txt');
    const args = [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`];
    writeFileSync(file, 'original\r\n');
    let app = await electron.launch({ args });
    const open = async () => {
      const page = await app.firstWindow();
      await app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
      }, repo);
      await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
      await page.getByRole('button', { name: 'Edit draft.txt', exact: true }).click();
      return page.getByRole('dialog', { name: 'Working file editor' });
    };
    try {
      let editor = await open();
      await editor.getByRole('textbox', { name: 'Working file text' }).fill('my recovered text');
      await editor.getByRole('combobox', { name: 'Line endings' }).selectOption('lf');
      await expect(editor.getByRole('status')).toHaveText('Draft saved locally');
      expect(readFileSync(file, 'utf8')).toBe('original\r\n');
      const main = app.process();
      const exited = once(main, 'exit');
      expect(main.kill('SIGKILL')).toBe(true);
      await exited;
      if (changed) writeFileSync(file, 'independent edit\n');
      app = await electron.launch({ args });
      editor = await open();
      await expect(editor.getByRole('status')).toHaveText('Recovered local draft');
      await expect(editor.getByRole('textbox', { name: 'Working file text' })).toContainText(
        'my recovered text',
      );
      await expect(editor.getByRole('combobox', { name: 'Line endings' })).toHaveValue('lf');
      const save = editor.getByRole('button', { name: 'Save file', exact: true });
      if (changed) {
        await expect(save).toBeDisabled();
        await expect(editor.getByRole('alert')).toContainText('file or checkout changed');
        await editor.getByRole('button', { name: 'Close editor', exact: true }).click();
        await editor.getByRole('button', { name: 'Discard draft', exact: true }).click();
        expect(readFileSync(file, 'utf8')).toBe('independent edit\n');
      } else {
        await save.click();
        await expect.poll(() => readFileSync(file, 'utf8')).toBe('my recovered text');
      }
      await expect(editor).toHaveCount(0);
      const page = await app.firstWindow();
      await page.getByRole('button', { name: 'Edit draft.txt', exact: true }).click();
      await expect(editor.getByRole('textbox', { name: 'Working file text' })).toContainText(
        changed ? 'independent edit' : 'my recovered text',
      );
      await expect(editor.getByText('Recovered local draft')).toHaveCount(0);
      await expect(save).toBeDisabled();
      await editor.getByRole('button', { name: 'Close editor', exact: true }).click();
    } finally {
      // An assertion may leave the editor dirty. Permit the native discard prompt on teardown.
      if (app.process().exitCode === null && app.process().signalCode === null) {
        await app.evaluate(({ dialog }) => {
          dialog.showMessageBoxSync = () => 1;
        });
        await app.close();
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
}
