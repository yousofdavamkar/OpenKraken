import { afterEach, expect, test } from 'vitest';
import { execFile } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { comparePayload, payloadManifest } from './package-security.mjs';
import { verifyMacBundle } from './dmg.mjs';

const run = promisify(execFile);
const temporary = [];
afterEach(async () => {
  for (const directory of temporary.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'openkraken-dmg-test-'));
  temporary.push(directory);
  return directory;
}

test.skipIf(process.platform !== 'linux')(
  'DMG creation refuses a non-macOS host before touching a bundle',
  async () => {
    await expect(
      run(process.execPath, ['scripts/installers.mjs', '--test-metadata', '--target', 'dmg']),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining('Target dmg requires native macOS'),
    });
  },
);

test.skipIf(process.platform === 'win32')(
  'copying a framework bundle preserves executable modes and relative links',
  async () => {
    const directory = await fixture();
    const source = join(directory, 'OpenKraken.app');
    const framework = join(source, 'Contents/Frameworks/Example.framework');
    await mkdir(join(framework, 'Versions/A'), { recursive: true, mode: 0o755 });
    await writeFile(join(framework, 'Versions/A/Example'), 'native fixture', { mode: 0o755 });
    await symlink('A', join(framework, 'Versions/Current'));
    await symlink('Versions/Current/Example', join(framework, 'Example'));
    const original = await payloadManifest(source);
    expect(original['Contents/Frameworks/Example.framework/Example']).toEqual({
      type: 'link',
      target: 'Versions/Current/Example',
    });
    expect(original['Contents/Frameworks/Example.framework/Versions/A/Example'].mode).toBe(0o755);
    const destination = join(directory, 'copied.app');
    await cp(source, destination, { recursive: true, verbatimSymlinks: true });
    comparePayload(original, await payloadManifest(destination));
    await chmod(
      join(destination, 'Contents/Frameworks/Example.framework/Versions/A/Example'),
      0o644,
    );
    const changed = await payloadManifest(destination);
    expect(() => comparePayload(original, changed)).toThrow('Installer payload differs');
  },
);

test.skipIf(process.platform === 'win32')(
  'an application payload cannot contain the external Applications shortcut',
  async () => {
    const source = await fixture();
    await symlink('/Applications', join(source, 'Applications'));
    await expect(payloadManifest(source)).rejects.toThrow('Payload link escapes bundle');
  },
);

test.skipIf(process.platform === 'win32')(
  'an application payload cannot ship a writable helper',
  async () => {
    const source = await fixture();
    const helper = join(source, 'helper');
    await writeFile(helper, 'native fixture');
    await chmod(helper, 0o777);
    await expect(payloadManifest(source)).rejects.toThrow('Payload has unsafe permissions');
  },
);

test('a foreign-platform DMG manifest is rejected before opening the artifact', async () => {
  const directory = await fixture();
  const manifest = join(directory, 'manifest.json');
  await writeFile(
    manifest,
    JSON.stringify({
      schemaVersion: 1,
      platform: process.platform === 'darwin' ? 'linux' : 'darwin',
      arch: process.arch,
      target: 'dmg',
      artifact: { file: 'absent.dmg' },
    }),
  );
  await expect(
    run(process.execPath, ['scripts/verify-installer.mjs', manifest]),
  ).rejects.toMatchObject({
    stderr: expect.stringContaining('Expected a native platform installer manifest'),
  });
});

test.skipIf(process.platform !== 'darwin').each([
  ['CFBundleIdentifier', 'wrong.product'],
  ['CFBundleExecutable', 'wrong-executable'],
  ['CFBundleShortVersionString', '9.9.9'],
  ['CFBundleURLSchemes', 'wrong-scheme'],
])('macOS rejects altered bundle metadata: %s', async (field, value) => {
  const directory = await fixture();
  const bundle = join(directory, 'OpenKraken.app');
  await mkdir(join(bundle, 'Contents'), { recursive: true });
  const info = {
    CFBundleIdentifier: 'org.openkraken.desktop',
    CFBundleExecutable: 'openkraken',
    CFBundleShortVersionString: '0.1.0',
    CFBundlePackageType: 'APPL',
    CFBundleURLTypes: [{ CFBundleURLSchemes: ['openkraken'] }],
  };
  if (field === 'CFBundleURLSchemes') info.CFBundleURLTypes[0].CFBundleURLSchemes = [value];
  else info[field] = value;
  const plist = join(bundle, 'Contents/Info.plist');
  await writeFile(plist, JSON.stringify(info));
  await run('/usr/bin/plutil', ['-convert', 'xml1', plist]);
  expect(await readFile(plist, 'utf8')).toContain('<plist');
  await expect(verifyMacBundle(bundle, '0.1.0')).rejects.toThrow(
    'macOS bundle identity, version, executable or repository scheme differs',
  );
});
