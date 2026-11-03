import { expect, test } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appImageTarget } from './src/appimage-target.js';

test.skipIf(process.platform !== 'linux')(
  'installation targets must belong to the running packaged AppImage layout',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'openkraken-appimage-target-'));
    try {
      const appdir = join(root, 'mounted');
      const executable = join(appdir, 'usr/lib/openkraken/openkraken');
      const image = join(root, 'OpenKraken.AppImage');
      await mkdir(join(appdir, 'usr/lib/openkraken'), { recursive: true });
      await writeFile(executable, 'fixture', { mode: 0o700 });
      await writeFile(image, 'fixture', { mode: 0o700 });
      await writeFile(
        join(appdir, 'openkraken-release.json'),
        JSON.stringify({ version: '0.1.0' }),
      );
      const runtime = {
        packaged: true,
        platform: 'linux',
        version: '0.1.0',
        executable,
        image,
        appdir,
      };
      expect(await appImageTarget(runtime)).toBe(image);
      for (const changes of [
        { packaged: false },
        { platform: 'darwin' },
        { version: '0.2.0' },
        { executable: image },
        { appdir: '/' },
        { image: 'relative.AppImage' },
        { image: undefined },
        { appdir: undefined },
      ])
        expect(await appImageTarget({ ...runtime, ...changes })).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
