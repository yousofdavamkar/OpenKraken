import { _electron as electron, expect, test } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createFixture } from '../../packages/test-fixtures/src/index.js';

const zsh = process.env.OPENKRAKEN_ZSH ?? '/usr/bin/zsh';

for (const startup of ['home', 'inherited', 'redirected'] as const) {
  test(`zsh integration preserves ${startup} startup files and user prompt hooks`, async () => {
    test.skip(process.platform !== 'linux' || !existsSync(zsh), 'Requires native Linux zsh');
    const root = mkdtempSync(join(tmpdir(), 'openkraken-terminal-zsh-'));
    const repository = createFixture(join(root, 'repo'), 'linear', 3);
    const shellProfile = join(root, 'shell profile');
    const alternate = join(shellProfile, 'custom config');
    mkdirSync(alternate, { recursive: true });
    const environmentFile = join(startup === 'inherited' ? alternate : shellProfile, '.zshenv');
    const rcFile = join(startup === 'home' ? shellProfile : alternate, '.zshrc');
    const environment = [
      'if [[ -n ${ZSH_TEST_MODULES-} ]]; then module_path=("$ZSH_TEST_MODULES"); fi',
      'typeset -gi USER_ENV_COUNT=${USER_ENV_COUNT:-0}+1',
      startup === 'redirected' ? 'ZDOTDIR="$HOME/custom config"' : '',
      '',
    ].join('\n');
    const configuration = [
      'HISTFILE=/dev/null',
      'typeset -gi USER_RC_COUNT=${USER_RC_COUNT:-0}+1',
      'PROMPT="custom-zsh> "',
      'precmd() { printf "HOOK:%s:PIPES:%s\\n" "$?" "${(j:,:)pipestatus}"; PROMPT="custom-zsh> "; }',
      'user_prompt() { printf "user-prompt\\n"; }',
      'precmd_functions=(user_prompt)',
      'preexec() { printf "user-preexec\\n"; }',
      'user_exec() { printf "user-exec-array\\n"; }',
      'preexec_functions=(user_exec)',
      '',
    ].join('\n');
    writeFileSync(environmentFile, environment);
    writeFileSync(rcFile, configuration);
    const env: Record<string, string> = { SHELL: zsh, HOME: shellProfile };
    for (const [name, value] of Object.entries(process.env))
      if (value !== undefined && !['SHELL', 'HOME', 'ZDOTDIR'].includes(name)) env[name] = value;
    delete env.ZDOTDIR;
    if (startup === 'inherited') env.ZDOTDIR = alternate;
    if (process.env.OPENKRAKEN_ZSH_MODULE_PATH)
      env.ZSH_TEST_MODULES = process.env.OPENKRAKEN_ZSH_MODULE_PATH;
    const app = await electron.launch({
      args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
      env,
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
      await expect(output).toContainText('custom-zsh>');
      await expect(integration).toHaveText('Ready for command');
      await command('sleep 1; false');
      await expect(integration).toHaveText('Command running');
      await expect(integration).toHaveText('Ready for command · last exit 1');
      await expect(output).toContainText('HOOK:1:PIPES:1');
      await expect(output).toContainText('user-prompt');
      await expect(output).toContainText('user-preexec');
      await expect(output).toContainText('user-exec-array');
      await command('printf "SAVED:%s:PIPES:%s\\n" "$?" "${(j:,:)pipestatus}"');
      await expect(output).toContainText('SAVED:1:PIPES:1');
      await command('false | true');
      await expect(output).toContainText('HOOK:0:PIPES:1,0');
      await command('printf "PIPELINE:%s:%s\\n" "$?" "${(j:,:)pipestatus}"');
      await expect(output).toContainText('PIPELINE:0:1,0');
      await command(
        'printf "STARTUP:%s:%s:DIR:%s\\n" "$USER_ENV_COUNT" "$USER_RC_COUNT" "${ZDOTDIR-UNSET}"',
      );
      await expect(output).toContainText(
        `STARTUP:1:1:DIR:${startup === 'home' ? 'UNSET' : alternate}`,
      );
      await command('(exit 23)');
      await expect(integration).toHaveText('Ready for command · last exit 23');
      await panel.getByRole('button', { name: 'Hide terminal', exact: true }).click();
      await page.getByRole('button', { name: 'Terminal', exact: true }).click();
      await expect(integration).toHaveText('Ready for command · last exit 23');
      await command('exit 5');
      await expect(panel.getByRole('status')).toHaveText('Exited with code 5');
      await expect(integration).toHaveText('Shell integration unavailable');
      expect(readFileSync(environmentFile, 'utf8')).toBe(environment);
      expect(readFileSync(rcFile, 'utf8')).toBe(configuration);
    } finally {
      await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const setting of [
  'readonly-prompt',
  'prompt-percent-off',
  'rcs-off',
  'readonly-directory',
] as const) {
  test(`zsh keeps a usable shell with incompatible startup settings: ${setting}`, async () => {
    test.skip(process.platform !== 'linux' || !existsSync(zsh), 'Requires native Linux zsh');
    const root = mkdtempSync(join(tmpdir(), 'openkraken-terminal-zsh-fallback-'));
    const repository = createFixture(join(root, 'repo'), 'linear', 3);
    const shellProfile = join(root, 'shell profile');
    const alternate = join(shellProfile, 'custom config');
    mkdirSync(alternate, { recursive: true });
    const configuration = [
      'typeset -gi USER_RC_COUNT=1',
      setting === 'readonly-prompt' ? 'readonly PROMPT' : '',
      setting === 'prompt-percent-off' ? 'unsetopt PROMPT_PERCENT' : '',
      'setopt errexit nounset',
      '',
    ].join('\n');
    writeFileSync(
      join(setting === 'readonly-directory' ? alternate : shellProfile, '.zshrc'),
      configuration,
    );
    writeFileSync(
      join(shellProfile, '.zshenv'),
      [
        'if [[ -n ${ZSH_TEST_MODULES-} ]]; then module_path=("$ZSH_TEST_MODULES"); fi',
        'typeset -gi USER_ENV_COUNT=1',
        'PROMPT="fallback> "',
        'HISTFILE=/dev/null',
        setting === 'rcs-off' ? 'unsetopt RCS' : '',
        setting === 'readonly-directory' ? 'readonly ZDOTDIR="$HOME/custom config"' : '',
        '',
      ].join('\n'),
    );
    const env: Record<string, string> = { SHELL: zsh, HOME: shellProfile };
    for (const [name, value] of Object.entries(process.env))
      if (value !== undefined && !['SHELL', 'HOME', 'ZDOTDIR'].includes(name)) env[name] = value;
    if (process.env.OPENKRAKEN_ZSH_MODULE_PATH)
      env.ZSH_TEST_MODULES = process.env.OPENKRAKEN_ZSH_MODULE_PATH;
    const app = await electron.launch({
      args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
      env,
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
      await expect(panel.getByLabel('Shell integration', { exact: true })).toHaveText(
        'Shell integration unavailable',
      );
      await input.pressSequentially(
        'printf "STARTUP:%s:%s:DIR:%s\\n" "$USER_ENV_COUNT" "${USER_RC_COUNT-0}" "${ZDOTDIR-UNSET}"',
      );
      await input.press('Enter');
      await expect(output).toContainText(
        `STARTUP:1:${setting === 'rcs-off' ? 0 : 1}:DIR:${setting === 'readonly-directory' ? alternate : 'UNSET'}`,
      );
      expect(await output.innerText()).not.toMatch(
        /read-only variable|parameter not set|readonly variable/,
      );
      await input.pressSequentially('exit 0');
      await input.press('Enter');
      await expect(panel.getByRole('status')).toHaveText('Exited with code 0');
    } finally {
      await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
