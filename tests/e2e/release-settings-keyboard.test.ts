import { _electron as electron, test } from '@playwright/test';
import { checkReleaseKeyboard } from './check-release-keyboard.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('release and diagnostics dialogs return keyboard users to the toolbar', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'openkraken-release-keyboard-'));
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${profile}`],
  });
  try {
    const page = await app.firstWindow();
    await checkReleaseKeyboard(page);
  } finally {
    await app.close();
    await rm(profile, { recursive: true, force: true });
  }
});
