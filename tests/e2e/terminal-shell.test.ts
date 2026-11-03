import { _electron as electron, expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createFixture } from '../../packages/test-fixtures/src/index.js';

for (const hooks of ['scalar', 'array', 'exported array'] as const) {
  test(`Bash integration retains ${hooks} prompt hooks, custom prompts and command status`, async () => {
    test.skip(
      process.platform !== 'linux',
      'Automatic Bash integration runtime acceptance on Linux',
    );
    const root = mkdtempSync(join(tmpdir(), 'openkraken-terminal-bash-'));
    const repository = createFixture(join(root, 'repo'), 'linear', 3);
    const shellProfile = join(root, 'shell-profile');
    mkdirSync(shellProfile);
    writeFileSync(
      join(shellProfile, '.bashrc'),
      [
        'HISTFILE=/dev/null',
        'PS1="custom> "',
        'PS0="before-command "',
        'trap ": user-debug-trap" DEBUG',
        'user_prompt() { printf "HOOK:%s:PIPES:%s\\n" "$?" "${PIPESTATUS[*]}"; PS1="custom> "; }',
        hooks === 'scalar'
          ? "PROMPT_COMMAND='user_prompt; true'"
          : `PROMPT_COMMAND=(user_prompt 'PS1="array-custom> "')`,
        hooks === 'exported array' ? 'export PROMPT_COMMAND' : '',
        '',
      ].join('\n'),
    );
    const app = await electron.launch({
      args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
      env: { ...process.env, SHELL: '/bin/bash', HOME: shellProfile },
    });
    try {
      const page = await app.firstWindow();
      await app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
        dialog.showMessageBoxSync = () => 1;
      }, repository);
      await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
      await page.getByRole('button', { name: 'Terminal', exact: true }).click();
      const panel = page.getByRole('region', { name: 'Terminal', exact: true });
      const input = panel.getByRole('textbox', { name: 'Terminal input', exact: true });
      const integration = panel.getByLabel('Shell integration', { exact: true });
      const output = panel.locator('.xterm-accessibility-tree');
      const command = async (text: string) => {
        await input.pressSequentially(text);
        await input.press('Enter');
      };
      await expect(integration).toContainText('Ready for command');
      await expect(output).toContainText('custom>');
      await command('sleep 1; false');
      await expect(integration).toHaveText('Command running');
      await expect(integration).toHaveText('Ready for command · last exit 1');
      await expect(output).toContainText('before-command');
      await expect(output).toContainText('HOOK:1:PIPES:1');
      await command('printf "SAVED:%s:PIPES:%s\\n" "$?" "${PIPESTATUS[*]}"');
      await expect(output).toContainText('SAVED:1:PIPES:1');
      await expect(integration).toHaveText('Ready for command · last exit 0');
      await command('false | true');
      await expect(output).toContainText('HOOK:0:PIPES:1 0');
      await command('printf "PIPELINE:%s:%s\\n" "$?" "${PIPESTATUS[*]}"');
      await expect(output).toContainText('PIPELINE:0:1 0');
      await command('trap -p DEBUG');
      await expect(output).toContainText("trap -- ': user-debug-trap' DEBUG");
      await command('(exit 23)');
      await expect(integration).toHaveText('Ready for command · last exit 23');
      await panel.getByRole('button', { name: 'Hide terminal', exact: true }).click();
      await page.getByRole('button', { name: 'Terminal', exact: true }).click();
      await expect(integration).toHaveText('Ready for command · last exit 23');
      await command('exit 5');
      await expect(panel.getByRole('status')).toHaveText('Exited with code 5');
      await expect(integration).toHaveText('Shell integration unavailable');
    } finally {
      await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const configuration of ['shopt -u promptvars', 'readonly PS1'] as const) {
  test(`Bash remains usable with incompatible prompt settings: ${configuration}`, async () => {
    test.skip(process.platform !== 'linux', 'Bash fallback runtime acceptance on Linux');
    const root = mkdtempSync(join(tmpdir(), 'openkraken-terminal-bash-fallback-'));
    const repository = createFixture(join(root, 'repo'), 'linear', 3);
    const shellProfile = join(root, 'shell-profile');
    mkdirSync(shellProfile);
    writeFileSync(
      join(shellProfile, '.bashrc'),
      `HISTFILE=/dev/null\nPS1="fallback> "\nset -eu\n${configuration}\n`,
    );
    const app = await electron.launch({
      args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
      env: { ...process.env, SHELL: '/bin/bash', HOME: shellProfile },
    });
    try {
      const page = await app.firstWindow();
      await app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
        dialog.showMessageBoxSync = () => 1;
      }, repository);
      await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
      await page.getByRole('button', { name: 'Terminal', exact: true }).click();
      const panel = page.getByRole('region', { name: 'Terminal', exact: true });
      const input = panel.getByRole('textbox', { name: 'Terminal input', exact: true });
      const output = panel.locator('.xterm-accessibility-tree');
      await expect(output).toContainText('fallback>');
      await expect(panel.getByRole('status')).toContainText('Running');
      await expect(panel.getByLabel('Shell integration', { exact: true })).toHaveText(
        'Shell integration unavailable',
      );
      await input.pressSequentially('printf "fallback-%s\\n" ok');
      await input.press('Enter');
      await expect(output).toContainText('fallback-ok');
      await input.pressSequentially('exit 0');
      await input.press('Enter');
      await expect(panel.getByRole('status')).toHaveText('Exited with code 0');
    } finally {
      await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
