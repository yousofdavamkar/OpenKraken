import { _electron as electron, expect, type ElectronApplication } from '@playwright/test';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

export async function loadHistory(app: ElectronApplication, path: string) {
  const page = await app.firstWindow();
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, path);
  await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
  const count = page.getByTestId('commit-count');
  await expect(count).toHaveText('2,000 commits · more available', { timeout: 60000 });
  for (const loaded of [7000, 12000, 17000]) {
    await page.getByRole('button', { name: 'Load more commits', exact: true }).click();
    await expect(count).toHaveText(`${loaded.toLocaleString('en-US')} commits · more available`);
  }
}

// The warm-up opens one repository in an otherwise empty profile.
function persistedWindowSize(profile: string, path: string) {
  const history = join(profile, 'history');
  expect(existsSync(history), 'Warm-up persisted a history window').toBe(true);
  const directories = readdirSync(history);
  expect(directories).toEqual([createHash('sha256').update(realpathSync(path)).digest('hex')]);
  let offset = 0;
  let key: string | undefined;
  for (const name of ['prefix.json', 'tail-0.json', 'tail-1.json', 'tail-2.json']) {
    const file = join(history, directories[0]!, name);
    const page = JSON.parse(readFileSync(file, 'utf8'));
    if (offset === 0) {
      expect(page.key, name).toMatch(/^[0-9a-f]{64}$/);
      key = page.key;
    } else expect(page.key, name).toBe(key);
    expect(page.offset, name).toBe(offset);
    expect(Array.isArray(page.commits), name).toBe(true);
    expect(page.commits, name).toHaveLength(offset === 0 ? 2000 : 5000);
    offset += page.commits.length;
  }
  return offset;
}

export async function warmHistoryProfile(profile: string, path: string) {
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${profile}`],
  });
  try {
    await loadHistory(app, path);
  } finally {
    await app.close();
  }
  return persistedWindowSize(profile, path);
}
