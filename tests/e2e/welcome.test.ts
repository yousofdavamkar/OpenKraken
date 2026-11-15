import { _electron as electron, expect, test } from '@playwright/test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createFixture, fixtureGit } from '../../packages/test-fixtures/src/index.js';

test('the welcome screen uses the preferred regional language and updates when it changes', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'openkraken-welcome-lang-'));
  const app = await electron.launch({
    args: [resolve('apps/desktop'), '--lang=es-MX', `--user-data-dir=${profile}`],
  });
  try {
    const page = await app.firstWindow();
    const welcome = page.getByRole('main');
    await expect(welcome).toHaveAttribute('lang', 'es');
    await expect(welcome.getByRole('button', { name: 'Abrir un repositorio' })).toBeVisible();
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'languages', { configurable: true, get: () => ['ja-JP'] });
      window.dispatchEvent(new Event('languagechange'));
    });
    await expect(welcome).toHaveAttribute('lang', 'en');
    await expect(welcome.getByRole('button', { name: 'Open a repository' })).toBeVisible();
  } finally {
    await app.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test('the guide can be skipped with the keyboard and reopened after a restart', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'openkraken-welcome-skip-'));
  const args = [resolve('apps/desktop'), '--lang=en-US', `--user-data-dir=${profile}`];
  let app = await electron.launch({ args });
  try {
    let page = await app.firstWindow();
    const local = page.getByRole('radio', { name: 'Open a folder' });
    await expect(local).toBeChecked();
    await local.focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('radio', { name: 'Clone a remote' })).toBeChecked();
    await page.getByRole('button', { name: 'Skip guide' }).focus();
    await page.keyboard.press('Enter');
    await expect(
      page.getByRole('main').getByRole('button', { name: 'Open a repository' }),
    ).toBeFocused();
    await app.close();
    app = await electron.launch({ args });
    page = await app.firstWindow();
    await expect(page.getByRole('radio')).toHaveCount(0);
    await page.getByRole('button', { name: 'Getting started' }).click();
    await expect(page.getByRole('radio', { name: 'Open a folder' })).toBeFocused();
    await expect(page.getByRole('group', { name: 'How would you like to start?' })).toBeVisible();
  } finally {
    await app.close();
    await rm(profile, { recursive: true, force: true });
  }
});

for (const action of ['open', 'clone', 'init'] as const) {
  test(`first run can ${action} a repository and remembers only a successful start`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'openkraken-welcome-repo-'));
    const profile = join(root, 'profile');
    const source = createFixture(join(root, 'source'));
    const destination = join(root, 'destination');
    await mkdir(destination);
    const args = [resolve('apps/desktop'), '--lang=en-US', `--user-data-dir=${profile}`];
    let app = await electron.launch({ args });
    try {
      let page = await app.firstWindow();
      const welcome = page.getByRole('main');
      const setDestination = (directory: string) =>
        app.evaluate(({ dialog }, path) => {
          dialog.showOpenDialog = async () => ({ canceled: !path, filePaths: path ? [path] : [] });
        }, directory);
      if (action === 'open') {
        const open = welcome.getByRole('button', { name: 'Open a repository' });
        await setDestination('');
        await open.click();
        await expect(open).toBeEnabled();
        await setDestination(destination);
        await open.click();
        await expect(page.getByRole('alert')).toBeVisible();
        await app.close();
        app = await electron.launch({ args });
        page = await app.firstWindow();
        await expect(page.getByRole('radio', { name: 'Open a folder' })).toBeChecked();
        await setDestination(source);
        await page.getByRole('main').getByRole('button', { name: 'Open a repository' }).click();
      } else if (action === 'clone') {
        await setDestination(destination);
        await welcome.getByRole('radio', { name: 'Clone a remote' }).check();
        await welcome.getByRole('button', { name: 'Clone a repository' }).click();
        const clone = page.getByRole('dialog', { name: 'Clone repository' });
        await clone.getByLabel('Repository URL or absolute path', { exact: true }).fill(source);
        await clone.getByRole('button', { name: 'Choose folder and clone' }).click();
      } else {
        await setDestination(destination);
        await welcome.getByRole('radio', { name: 'Start a new repository' }).check();
        await welcome.getByRole('button', { name: 'Initialize a repository' }).click();
        await expect(page.getByLabel('Initial branch')).toBeFocused();
        await page.getByRole('button', { name: 'Cancel initialization' }).click();
        await expect(
          welcome.getByRole('button', { name: 'Initialize a repository' }),
        ).toBeFocused();
        await welcome.getByRole('button', { name: 'Initialize a repository' }).click();
        await page.getByLabel('Initial branch').fill('guide-branch');
        await page.getByRole('button', { name: 'Choose folder and initialize' }).click();
      }
      await expect(page.getByTestId('commit-count')).toHaveText(
        action === 'init' ? '0 commits' : '8 commits',
      );
      if (action === 'clone')
        expect(fixtureGit(destination, ['rev-parse', 'HEAD'])).toBe(
          fixtureGit(source, ['rev-parse', 'HEAD']),
        );
      if (action === 'init')
        expect(fixtureGit(destination, ['symbolic-ref', '--short', 'HEAD'])).toBe('guide-branch');
      await app.close();
      app = await electron.launch({ args });
      page = await app.firstWindow();
      await expect(page.getByRole('button', { name: 'Getting started' })).toBeVisible();
      await expect(page.getByRole('radio')).toHaveCount(0);
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
