import { build, Platform, Arch } from 'electron-builder';
import { buildAppImage } from './appimage.mjs';
import { buildDmg, verifyMacBundle } from './dmg.mjs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { comparePayload, payloadManifest, sha256, verifyFuses } from './package-security.mjs';

const run = promisify(execFile);
// Generated desktop/AppArmor files must not inherit a group-writable build umask.
process.umask(0o022);
const { values } = parseArgs({
  options: {
    target: { type: 'string', default: process.platform === 'darwin' ? 'dmg' : 'deb' },
    'test-metadata': { type: 'boolean', default: false },
    metadata: { type: 'string' },
  },
});
const target = values.target;
if (!['linux', 'darwin'].includes(process.platform) || !['x64', 'arm64'].includes(process.arch))
  throw new Error('This installer pipeline supports native Linux/macOS x64/arm64 builds only');
if (!['deb', 'rpm', 'AppImage', 'dmg'].includes(target))
  throw new Error('Supported targets: deb, rpm, AppImage, dmg');
if (target === 'dmg' ? process.platform !== 'darwin' : process.platform !== 'linux')
  throw new Error(`Target ${target} requires native ${target === 'dmg' ? 'macOS' : 'Linux'}`);
if (values['test-metadata'] === Boolean(values.metadata))
  throw new Error('Choose --test-metadata for local validation or --metadata <JSON file>');
const testMetadata = values['test-metadata'];
const metadata = testMetadata
  ? {
      name: 'OpenKraken local validation only',
      email: 'not-for-distribution@example.invalid',
      homepage: 'https://example.invalid/openkraken-test-build',
      license: 'UNLICENSED',
    }
  : JSON.parse(await readFile(resolve(values.metadata), 'utf8'));
if (
  !metadata ||
  Object.keys(metadata).sort().join(',') !== 'email,homepage,license,name' ||
  !['name', 'email', 'homepage', 'license'].every(
    (key) => typeof metadata[key] === 'string' && /^[\x20-\x7e]{1,200}$/.test(metadata[key]),
  ) ||
  !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(metadata.email) ||
  /[<>]/.test(metadata.name) ||
  !/^https:\/\/[^\s]+$/.test(metadata.homepage) ||
  !/^[A-Za-z0-9 .()+-]+$/.test(metadata.license)
)
  throw new Error('Metadata must contain only name, email, HTTPS homepage and license strings');
const homepage = new URL(metadata.homepage);
if (homepage.username || homepage.password || homepage.hash)
  throw new Error('Homepage must not contain credentials or a fragment');

const root = resolve('.');
const source = join(
  root,
  `release/OpenKraken-${process.platform}-${process.arch}`,
  target === 'dmg' ? 'OpenKraken.app' : '',
);
const original = await payloadManifest(source);
await verifyFuses(target === 'dmg' ? source : join(source, 'openkraken'));
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
if (target === 'dmg') await verifyMacBundle(source, version);
const staged = JSON.parse(await readFile('release/staging/package.json', 'utf8'));
if (staged.version !== version || staged.desktopName !== 'openkraken.desktop')
  throw new Error('Rebuild the platform bundle with pnpm package before building installers');
const git = (await run('git', ['rev-parse', 'HEAD'])).stdout.trim();
const dirty = Boolean((await run('git', ['status', '--porcelain'])).stdout.trim());
const output = join(
  root,
  `release/installers/${process.platform}-${process.arch}`,
  testMetadata ? 'test' : 'unsigned',
  target,
);
await mkdir(output, { recursive: true });
const work = await mkdtemp(join(root, 'release/installer-work-'));
try {
  const prepackaged = join(work, target === 'dmg' ? 'OpenKraken.app' : 'app');
  await cp(source, prepackaged, { recursive: true, verbatimSymlinks: true });
  comparePayload(original, await payloadManifest(prepackaged));
  let artifacts;
  let appdir;
  if (target === 'dmg') {
    artifacts = [
      await buildDmg(
        prepackaged,
        work,
        `OpenKraken-${version}-darwin-${process.arch}${testMetadata ? '-TEST-ONLY' : '-unsigned'}.dmg`,
        version,
      ),
    ];
  } else if (target === 'AppImage') {
    const built = await buildAppImage(
      prepackaged,
      work,
      `OpenKraken-${version}-linux-${process.arch}${testMetadata ? '-TEST-ONLY' : '-unsigned'}.AppImage`,
      { version, metadata, metadataMode: testMetadata ? 'test-only' : 'provided', signed: false },
    );
    artifacts = [built.artifact];
    appdir = built.appdir;
  } else
    artifacts = await build({
      projectDir: root,
      prepackaged,
      targets: Platform.LINUX.createTarget(target, Arch[process.arch]),
      publish: 'never',
      config: {
        appId: 'org.openkraken.desktop',
        productName: 'OpenKraken',
        executableName: 'openkraken',
        electronVersion: '45.2.1',
        protocols: [{ name: 'OpenKraken repository links', schemes: ['openkraken'] }],
        npmRebuild: false,
        publish: null,
        directories: { output: join(work, 'output'), buildResources: 'build-resources' },
        artifactName: `OpenKraken-${version}-linux-${process.arch}${testMetadata ? '-TEST-ONLY' : '-unsigned'}.\${ext}`,
        extraMetadata: {
          name: 'openkraken',
          version,
          desktopName: 'openkraken.desktop',
          description: testMetadata
            ? 'OpenKraken local installer validation — not for distribution'
            : 'OpenKraken desktop Git client',
          author: { name: metadata.name, email: metadata.email },
          homepage: metadata.homepage,
          license: metadata.license,
        },
        linux: {
          icon: 'build-resources/openkraken.png',
          category: 'Development',
          executableArgs: [],
          syncDesktopName: true,
          desktop: { entry: { StartupWMClass: 'openkraken', Terminal: 'false' } },
        },
        [target]: {
          fpm: [
            '--depends',
            'git >= 2.38',
            '--depends',
            'ca-certificates',
            // Builder's defaults omit direct Electron shared-library requirements.
            // Keep its defaults and add these so fresh desktop installs can start.
            ...(target === 'deb'
              ? ['libasound2t64 | libasound2', 'libgbm1', 'libcups2t64 | libcups2', 'libstdc++6']
              : [
                  'libasound.so.2()(64bit)',
                  'libgbm.so.1()(64bit)',
                  'libcups.so.2()(64bit)',
                  'libsecret-1.so.0()(64bit)',
                  'libstdc++.so.6()(64bit)',
                ]
            ).flatMap((dependency) => ['--depends', dependency]),
            ...(target === 'rpm'
              ? [
                  '--rpm-rpmbuild-define',
                  '_rpmformat 4',
                  '--rpm-digest',
                  'sha256',
                  // Own only the private application tree. RPM can then remove
                  // its empty directories without a destructive removal hook.
                  '--directories',
                  '/opt/OpenKraken',
                ]
              : []),
          ],
          afterRemove: 'build-resources/linux-after-remove.sh',
        },
      },
    });
  const payload = await payloadManifest(appdir ?? prepackaged);
  if (appdir) {
    comparePayload(original, await payloadManifest(join(appdir, 'usr/lib/openkraken')));
  } else if (target === 'dmg') {
    comparePayload(original, payload);
  } else {
    // FPM adds this profile for Ubuntu's user namespace policy. Nothing else may
    // change, particularly the ASAR, fuses, native modules or helper permissions.
    const { 'resources/apparmor-profile': profile, ...unchanged } = payload;
    if (!profile || profile.type !== 'file')
      throw new Error('Expected AppArmor profile is missing');
    comparePayload(original, unchanged);
  }
  comparePayload(original, await payloadManifest(source));
  await verifyFuses(target === 'dmg' ? prepackaged : join(prepackaged, 'openkraken'));
  if (artifacts.length !== 1 || !artifacts[0].endsWith(`.${target}`))
    throw new Error('Expected exactly one installer artifact');
  const artifact = artifacts[0];
  const manifest = {
    schemaVersion: 1,
    target,
    platform: process.platform,
    arch: process.arch,
    version,
    metadataMode: testMetadata ? 'test-only' : 'provided',
    metadata,
    signed: false,
    source: { commit: git, dirty },
    artifact: {
      file: basename(artifact),
      size: (await stat(artifact)).size,
      sha256: await sha256(artifact),
    },
    payload,
  };
  await cp(artifact, join(output, basename(artifact)));
  await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(
    `Unsigned ${testMetadata ? 'TEST-ONLY ' : ''}installer: ${join(output, basename(artifact))}`,
  );
  console.log(
    `Verify and smoke-test with: node scripts/verify-installer.mjs ${join(output, 'manifest.json')}`,
  );
} finally {
  await rm(work, { recursive: true, force: true });
}
