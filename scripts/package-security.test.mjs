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

async function withPackage(changes, check) {
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
    check(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test.each([
  ['matching beta', {}, true],
  ['previous beta', { version: '0.2.0-beta.1' }, false],
  ['stable release', { version: '0.2.0' }, false],
  ['different application', { name: 'other' }, false],
  ['different desktop entry', { desktopName: 'other.desktop' }, false],
  ['different main entry point', { main: 'dist/other.cjs' }, false],
])('checks the packaged application descriptor: %s', async (_name, changes, valid) => {
  await withPackage(changes, (directory) => {
    const verify = () => verifyPackagedApplication(directory, application.version);
    if (valid) expect(verify).not.toThrow();
    else expect(verify).toThrow(/Packaged application identity or version differs/);
  });
});

test('installer source comes from the built application, including a dirty checkout', async () => {
  const source = { commit: 'a'.repeat(40), dirty: true };
  await withPackage({ openkrakenSource: source }, (directory) => {
    const verify = (claimed) => verifyPackagedApplication(directory, application.version, claimed);
    expect(verify()).toEqual(source);
    expect(verify(source)).toEqual(source);
    for (const mismatch of [
      null,
      { ...source, dirty: false },
      { ...source, commit: 'b'.repeat(40) },
    ])
      expect(() => verify(mismatch)).toThrow(/source differs/);
  });
});

test('an export records unknown source and older archives can still be verified', async () => {
  const previous = { commit: 'a'.repeat(40), dirty: false };
  await withPackage({ openkrakenSource: null }, (directory) => {
    expect(verifyPackagedApplication(directory, application.version, null)).toBeNull();
    expect(() => verifyPackagedApplication(directory, application.version, previous)).toThrow(
      /source differs/,
    );
  });
  await withPackage({}, (directory) => {
    expect(verifyPackagedApplication(directory, application.version, previous)).toBeNull();
  });
  await withPackage({ openkrakenSource: { ...previous, commit: 'invalid' } }, (directory) => {
    expect(() => verifyPackagedApplication(directory, application.version)).toThrow(
      /Invalid packaged application source/,
    );
  });
});
