import { _electron as electron, expect, test } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createFixture } from '../../packages/test-fixtures/src/index.js';

const pwsh = process.env.OPENKRAKEN_POWERSHELL ?? '/opt/microsoft/powershell/7/pwsh';

for (const mode of ['custom', 'default', 'protected'] as const) {
  test(`PowerShell reports command outcomes and respects the ${mode} prompt`, async () => {
    test.skip(
      process.platform !== 'linux' || !existsSync(pwsh),
      'Requires native PowerShell 7 on Linux',
    );
    const root = mkdtempSync(join(tmpdir(), 'openkraken-terminal-pwsh-'));
    const repository = createFixture(join(root, 'repo'), 'linear', 3);
    const shellProfile = join(root, 'shell-profile');
    const configDirectory = join(shellProfile, '.config');
    mkdirSync(join(configDirectory, 'powershell'), { recursive: true });
    const config = join(configDirectory, 'powershell/Microsoft.PowerShell_profile.ps1');
    const configuration = [
      'Set-PSReadLineOption -PredictionSource None -HistorySaveStyle SaveNothing',
      "function global:prompt { if ($?) { 'custom-ok> ' } else { 'custom-failed> ' } }",
      '',
    ].join('\n');
    const profileText =
      mode === 'protected'
        ? configuration + 'Set-Item Function:prompt -Options ReadOnly\n'
        : configuration;
    if (mode !== 'default') writeFileSync(config, profileText);
    const app = await electron.launch({
      args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
      env: {
        ...process.env,
        SHELL: pwsh,
        HOME: shellProfile,
        XDG_CONFIG_HOME: configDirectory,
        XDG_DATA_HOME: join(shellProfile, '.local/share'),
        XDG_CACHE_HOME: join(shellProfile, '.cache'),
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
      if (mode !== 'default') await expect(output).toContainText('custom-ok>');
      if (mode === 'protected') {
        await command('Write-Output (6 * 7)');
        await expect(output).toContainText('42');
        await expect(integration).toHaveText('Shell integration unavailable');
        await command('exit 0');
        await expect(panel.getByRole('status')).toHaveText('Exited with code 0');
        expect(readFileSync(config, 'utf8')).toBe(profileText);
        return;
      }
      await expect(integration).toHaveText('Ready for command');
      await command("Start-Sleep 1; /bin/sh -c 'exit 23'");
      await expect(integration).toHaveText('Command running');
      await expect(integration).toHaveText('Ready for command · last exit 23');
      if (mode === 'custom') await expect(output).toContainText('custom-failed>');
      await command('Write-Output "SAVED=$? NATIVE=$LASTEXITCODE"');
      await expect(output).toContainText('SAVED=False NATIVE=23');
      await expect(integration).toHaveText('Ready for command · last exit 0');
      await command('Write-Error oops');
      await expect(integration).toHaveText('Ready for command · last exit 1');
      await command("$PSNativeCommandUseErrorActionPreference=$true; /bin/sh -c 'exit 7'");
      await expect(integration).toHaveText('Ready for command · last exit 7');
      await command('exit 5');
      await expect(panel.getByRole('status')).toHaveText('Exited with code 5');
      await expect(integration).toHaveText('Shell integration unavailable');
      if (mode === 'default') expect(existsSync(config)).toBe(false);
      else expect(readFileSync(config, 'utf8')).toBe(profileText);
    } finally {
      await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
