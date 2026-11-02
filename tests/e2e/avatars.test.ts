import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createFixture } from '../../packages/test-fixtures/src/index.js';
test('author photos are opt-in, cached, and available offline after restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-photos-'));
  const repository = createFixture(join(root, 'repo'), 'merge'),
    profile = join(root, 'profile');
  const args = [resolve('apps/desktop'), `--user-data-dir=${profile}`];
  let app = await electron.launch({ args });
  const open = async () => {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, repository);
    await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
    await expect(page.getByTestId('commit-graph')).toBeVisible();
    return page;
  };
  try {
    await app.evaluate(({ session, nativeImage }) => {
      const data = nativeImage
        .createFromBitmap(Buffer.from([40, 200, 160, 255]), { width: 1, height: 1 })
        .toPNG();
      session.fromPartition('openkraken-avatars').fetch = async (input, init) => {
        if (
          !/^https:\/\/gravatar.com\/avatar\/[0-9a-f]{64}\?s=32&d=404$/.test(String(input)) ||
          init?.credentials !== 'omit'
        )
          throw new Error('Unexpected avatar request');
        return new Response(Uint8Array.from(data), { headers: { 'content-type': 'image/png' } });
      };
    });
    let page = await open();
    const setting = page.getByRole('checkbox', { name: 'Author photos' });
    await expect(setting).not.toBeChecked();
    await expect(page.locator('img.author-avatar')).toHaveCount(0);
    await setting.click();
    await expect(setting).toBeChecked();
    await expect(page.locator('img.author-avatar')).toHaveCount(4);
    expect(
      await page
        .locator('img.author-avatar')
        .first()
        .evaluate((img: HTMLImageElement) => img.naturalWidth),
    ).toBe(32);
    expect(readdirSync(join(profile, 'avatars')).filter((f) => f.endsWith('.json'))).toHaveLength(
      1,
    );
    await app.close();
    app = await electron.launch({ args });
    await app.evaluate(({ session }) => {
      session.fromPartition('openkraken-avatars').fetch = async () => {
        throw new Error('offline');
      };
    });
    page = await open();
    await expect(page.getByRole('checkbox', { name: 'Author photos' })).toBeChecked();
    await expect(page.locator('img.author-avatar')).toHaveCount(4);
    await page.getByRole('checkbox', { name: 'Author photos' }).click();
    await expect(page.getByRole('checkbox', { name: 'Author photos' })).not.toBeChecked();
    await expect(page.locator('img.author-avatar')).toHaveCount(0);
    await expect(page.locator('.author-avatar.initials')).toHaveCount(4);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
