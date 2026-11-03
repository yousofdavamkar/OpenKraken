import { _electron as electron, expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createFixture } from '../../packages/test-fixtures/src/index.js';

const fish = process.env.OPENKRAKEN_FISH ?? '/usr/bin/fish';

for (const mode of ['default', 'enabled', 'disabled'] as const) {
  test(`native fish prompt markers: ${mode}`, async () => {
    test.skip(process.platform !== 'linux' || !existsSync(fish), 'Requires native Linux fish');
    const version = execFileSync(fish, ['--version'], { encoding: 'utf8' });
    test.skip(
      mode === 'default' && !/\bversion (?:[4-9]|\d{2,})\./.test(version),
      'Native markers are enabled by default from fish 4',
    );
    const enabled = mode !== 'disabled';
    const root = mkdtempSync(join(tmpdir(), 'openkraken-terminal-fish-'));
    const repository = createFixture(join(root, 'repo'), 'linear', 3);
    const shellProfile = join(root, 'shell-profile');
    const configDirectory = join(shellProfile, '.config');
    mkdirSync(join(configDirectory, 'fish'), { recursive: true });
    const config = join(configDirectory, 'fish/config.fish');
    const configuration = [
      'set -g fish_greeting',
      'set -g fish_history ""',
      'function fish_prompt',
      '  printf "FISH:%s:PIPES:%s\\ncustom-fish> " "$status" (string join , $pipestatus)',
      'end',
      'function user_preexec --on-event fish_preexec',
      '  printf "user-preexec\\n"',
      'end',
      'function user_postexec --on-event fish_postexec',
      '  printf "POST:%s:PIPES:%s\\n" "$status" (string join , $pipestatus)',
      'end',
      '',
    ].join('\n');
    writeFileSync(config, configuration);
    const app = await electron.launch({
      args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
      env: {
        ...process.env,
        SHELL: fish,
        HOME: shellProfile,
        XDG_CONFIG_HOME: configDirectory,
        fish_features: mode === 'default' ? '' : enabled ? 'mark-prompt' : 'no-mark-prompt',
      },
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
      await expect(output).toContainText('custom-fish>');
      await expect(integration).toHaveText(
        enabled ? /^(?:Prompt|Ready for command)$/ : 'Shell integration unavailable',
      );
      await command('sleep 1; false');
      if (enabled) {
        await expect(integration).toHaveText('Command running');
        await expect(integration).toHaveText(/^(?:Prompt|Ready for command) · last exit 1$/);
      }
      await expect(output).toContainText('POST:1:PIPES:1');
      await expect(output).toContainText('FISH:1:PIPES:1');
      await expect(output).toContainText('user-preexec');
      await command('printf "SAVED:%s:PIPES:%s\\n" "$status" (string join , $pipestatus)');
      await expect(output).toContainText('SAVED:1:PIPES:1');
      await command('false | true');
      await expect(output).toContainText('POST:0:PIPES:1,0');
      await expect(output).toContainText('FISH:0:PIPES:1,0');
      await command('sh -c "exit 23"');
      await expect(output).toContainText('POST:23:PIPES:23');
      if (enabled)
        await expect(integration).toHaveText(/^(?:Prompt|Ready for command) · last exit 23$/);
      await panel.getByRole('button', { name: 'Hide terminal', exact: true }).click();
      await page.getByRole('button', { name: 'Terminal', exact: true }).click();
      await expect(integration).toHaveText(
        enabled ? /^(?:Prompt|Ready for command) · last exit 23$/ : 'Shell integration unavailable',
      );
      await command('exit 5');
      await expect(panel.getByRole('status')).toHaveText('Exited with code 5');
      await expect(integration).toHaveText('Shell integration unavailable');
      expect(readFileSync(config, 'utf8')).toBe(configuration);
    } finally {
      await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
