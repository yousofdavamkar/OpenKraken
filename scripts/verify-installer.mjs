import { authenticateRpm } from './rpm-signature.mjs';
import { verifyLinuxPackage } from './linux-package.mjs';
import { execFile, spawn } from 'node:child_process';
import { parseArgs, promisify } from 'node:util';
import { copyFile, readFile, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import {
  comparePayload,
  payloadManifest,
  sha256,
  verifyFuses,
  verifyPackagedApplication,
} from './package-security.mjs';
import { macIdentity, verifyDmgReceipt } from './mac-signing.mjs';
import { verifyDmg } from './dmg.mjs';
import { verifyMsi, windowsIdentity } from './msi.mjs';

// RPM may omit implicit parent directory entries. Create those with safe modes,
// while -p below preserves all explicitly archived permissions for inspection.
process.umask(0o022);

// Only run this on artifacts built locally or independently authenticated.
// SHA-256 detects corruption; this adjacent manifest is not a release signature.
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    'require-notarization': { type: 'boolean' },
    'win-identity': { type: 'string' },
    'require-timestamp': { type: 'boolean', default: false },
    'mac-identity': { type: 'string' },
    'rpm-key': { type: 'string' },
  },
});
if (positionals.length !== 1) throw new Error('Provide one installer manifest');
const rpmKey = values['rpm-key'];
const manifestPath = resolve(positionals[0]);
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (
  manifest.schemaVersion !== 1 ||
  !['linux', 'darwin', 'win32'].includes(manifest.platform) ||
  process.platform !== manifest.platform ||
  process.arch !== manifest.arch ||
  !(
    manifest.platform === 'darwin'
      ? ['dmg']
      : manifest.platform === 'win32'
        ? ['msi']
        : ['deb', 'rpm', 'AppImage']
  ).includes(manifest.target) ||
  manifest.artifact?.file !== basename(manifest.artifact?.file ?? '') ||
  !manifest.artifact.file.endsWith(`.${manifest.target}`)
)
  throw new Error('Expected a native platform installer manifest');
const winIdentity = windowsIdentity(manifest.target, values['win-identity']);
if (values['require-timestamp'] && !winIdentity)
  throw new Error('--require-timestamp requires --win-identity');
const identity = macIdentity(manifest.target, values['mac-identity']);
if (values['require-notarization'] && manifest.target !== 'dmg')
  throw new Error('--require-notarization requires a DMG');
if (manifest.target === 'dmg') verifyDmgReceipt(manifest, identity, values['require-notarization']);
if (rpmKey !== undefined && (!rpmKey || manifest.target !== 'rpm'))
  throw new Error('--rpm-key requires an RPM target and a public certificate file');
if (
  manifest.target === 'rpm' &&
  (manifest.signed !== !!rpmKey || (!rpmKey && manifest.signingFingerprint !== undefined))
)
  throw new Error('Verifying a signed RPM requires --rpm-key with the trusted public certificate');
async function verifyChecksum(file) {
  if (
    (await stat(file)).size !== manifest.artifact.size ||
    (await sha256(file)) !== manifest.artifact.sha256
  )
    throw new Error('Installer checksum or size mismatch');
}
const source = join(dirname(manifestPath), manifest.artifact.file);
if (!rpmKey && !['dmg', 'msi'].includes(manifest.target)) await verifyChecksum(source);
if (manifest.target === 'dmg') {
  await verifyDmg(source, manifest, identity);
} else if (manifest.target === 'msi') {
  await verifyMsi(source, manifest, winIdentity, values['require-timestamp']);
} else {
  await verifyLinuxInstaller();
}

async function verifyLinuxInstaller() {
  const run = promisify(execFile);
  await mkdir('release', { recursive: true });
  const temporary = await mkdtemp(resolve('release/installer-check-'));
  try {
    let artifact = source;
    if (rpmKey) {
      // A concurrent build may replace the published file. Authenticate and
      // extract the same private copy throughout this verification.
      artifact = join(temporary, 'candidate.rpm');
      await copyFile(source, artifact);
      await verifyChecksum(artifact);
      const fingerprint = await authenticateRpm(artifact, resolve(rpmKey), temporary);
      if (fingerprint !== manifest.signingFingerprint)
        throw new Error('RPM manifest signing fingerprint differs from trusted certificate');
      console.log(`Verified RPM signature against trusted certificate ${fingerprint}`);
    }
    if (manifest.target === 'deb' || manifest.target === 'rpm')
      await verifyLinuxPackage(artifact, manifest, temporary);
    let directory = join(temporary, 'opt/OpenKraken');
    let desktopPath = join(temporary, 'usr/share/applications/openkraken.desktop');
    if (manifest.target === 'AppImage') {
      await run(artifact, ['--appimage-extract'], { cwd: temporary, maxBuffer: 8 * 1024 * 1024 });
      const appdir = join(temporary, 'squashfs-root');
      comparePayload(manifest.payload, await payloadManifest(appdir));
      directory = join(appdir, 'usr/lib/openkraken');
      desktopPath = join(appdir, 'openkraken.desktop');
      const launcher = await readFile(join(appdir, 'AppRun'), 'utf8');
      if (launcher !== (await readFile('build-resources/AppRun', 'utf8')))
        throw new Error('AppImage launcher differs from the reviewed sandbox-preserving launcher');
      await run('sh', ['-n', join(appdir, 'AppRun')]);
    } else if (manifest.target === 'deb') {
      await run('dpkg-deb', ['--extract', artifact, temporary]);
      const { stdout: dependencies } = await run('dpkg-deb', ['--field', artifact, 'Depends']);
      if (
        !/git \(>= 2\.38\)/.test(dependencies) ||
        !/(?:^|,\s*)ca-certificates(?:,|\s*$)/.test(dependencies)
      )
        throw new Error('Git version or CA certificate dependency missing');
      await run('dpkg-deb', ['--control', artifact, join(temporary, 'DEBIAN')]);
      for (const script of ['postinst', 'postrm']) {
        const text = await readFile(join(temporary, 'DEBIAN', script), 'utf8');
        if (text.includes('--no-sandbox') || text.includes('--disable-sandbox'))
          throw new Error('Installer disables the Chromium sandbox');
        await run('bash', ['-n', join(temporary, 'DEBIAN', script)]);
      }
    } else {
      const database = join(temporary, 'rpmdb');
      // Even query-only RPM 6 can attempt to lock the system RPM database. Keep
      // this verification entirely inside the disposable extraction directory.
      const query = ['--dbpath', database, '-qp'];
      const { stdout: dependencies } = await run('rpm', [...query, '--requires', artifact]);
      if (!/^git >= 2\.38$/m.test(dependencies) || !/^ca-certificates$/m.test(dependencies))
        throw new Error('Git version or CA certificate dependency missing');
      const { stdout: scripts } = await run('rpm', [...query, '--scripts', artifact]);
      if (scripts.includes('--no-sandbox') || scripts.includes('--disable-sandbox'))
        throw new Error('Installer disables the Chromium sandbox');
      const { stdout: files } = await run('rpm', [...query, '--list', artifact]);
      const owned = new Set(files.trimEnd().split('\n'));
      for (const directory of [
        '/opt/OpenKraken',
        ...Object.entries(manifest.payload)
          .filter(([, entry]) => entry.type === 'directory')
          .map(([name]) => `/opt/OpenKraken/${name}`),
      ]) {
        if (!owned.has(directory))
          throw new Error(`RPM does not own its application directory: ${directory}`);
      }
      // No shell interpolation or root install: bsdtar reads the RPM payload directly.
      await run('bsdtar', ['-xpf', artifact, '-C', temporary]);
    }
    if (manifest.target !== 'AppImage')
      comparePayload(manifest.payload, await payloadManifest(directory));
    await verifyFuses(join(directory, 'openkraken'));
    verifyPackagedApplication(directory, manifest.version, manifest.source ?? null);
    const desktop = await readFile(desktopPath, 'utf8');
    const expectedExec =
      manifest.target === 'AppImage'
        ? /^Exec=AppRun %U$/m
        : /^Exec=\/opt\/OpenKraken\/openkraken %U$/m;
    if (
      !expectedExec.test(desktop) ||
      !/^Icon=openkraken$/m.test(desktop) ||
      !/^StartupWMClass=openkraken$/m.test(desktop) ||
      !/^MimeType=x-scheme-handler\/openkraken;$/m.test(desktop) ||
      /--(?:no|disable)-sandbox/.test(desktop)
    )
      throw new Error('Desktop launcher does not match the sandboxed application');
    console.log('Installer payload, launch entry and Electron fuses verified');
    const smoke = spawn(process.execPath, ['scripts/smoke-package.mjs'], {
      stdio: 'inherit',
      env: {
        ...process.env,
        OPENKRAKEN_PACKAGE_DIRECTORY: directory,
        OPENKRAKEN_PACKAGE_EXECUTABLE:
          manifest.target === 'AppImage' ? artifact : join(directory, 'openkraken'),
      },
    });
    await new Promise((resolve, reject) => {
      smoke.once('error', reject);
      smoke.once('exit', (code, signal) =>
        code === 0 ? resolve() : reject(new Error(`Installer smoke failed: ${code ?? signal}`)),
      );
    });
    console.log(
      manifest.target === 'AppImage'
        ? 'Verified AppImage payload and launch through its embedded runtime'
        : `Verified extracted ${manifest.target} payload; install/uninstall lifecycle is a separate gate`,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
