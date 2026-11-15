import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { verifyPackagedApplication } from './package-security.mjs';

const require = createRequire(import.meta.url);
const { createPackage } = createRequire(require.resolve('@electron/packager'))('@electron/asar');
const application = {
  version: '0.2.0-beta.2',
  name: 'openkraken',
  desktopName: 'openkraken.desktop',
  main: 'dist/main.cjs',
};

test.each([
  ['matching beta', {}, true],
  ['previous beta', { version: '0.2.0-beta.1' }, false],
  ['stable release', { version: '0.2.0' }, false],
  ['different application', { name: 'other' }, false],
  ['different desktop entry', { desktopName: 'other.desktop' }, false],
  ['different main entry point', { main: 'dist/other.cjs' }, false],
])('checks the packaged application descriptor: %s', async (_name, changes, valid) => {
  const directory = await mkdtemp(join(tmpdir(), 'openkraken-bundle-'));
  const source = join(directory, 'source');
  const resources = join(
    directory,
    process.platform === 'darwin' ? 'Contents/Resources' : 'resources',
  );
  try {
    await mkdir(source);
    await mkdir(resources, { recursive: true });
    await writeFile(join(source, 'package.json'), JSON.stringify({ ...application, ...changes }));
    await createPackage(source, join(resources, 'app.asar'));
    const verify = () => verifyPackagedApplication(directory, application.version);
    if (valid) expect(verify).not.toThrow();
    else expect(verify).toThrow(/Packaged application identity or version differs/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
