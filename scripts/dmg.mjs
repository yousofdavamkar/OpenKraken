import { execFile, spawn } from 'node:child_process';
import { copyFile, stat, lstat, mkdir, mkdtemp, readlink, rm, symlink } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { signDiskImage, verifyMacSignature, verifyNotaryTicket } from './mac-signing.mjs';
import { promisify } from 'node:util';
import {
  comparePayload,
  payloadManifest,
  sha256,
  verifyFuses,
  verifyPackagedApplication,
} from './package-security.mjs';

const run = promisify(execFile);
const commandOptions = { timeout: 180_000, maxBuffer: 8 * 1024 * 1024 };

function requireMac() {
  if (process.platform !== 'darwin') throw new Error('DMG operations require native macOS');
}

export async function verifyMacBundle(bundle, version, identity) {
  requireMac();
  if (!(await lstat(bundle)).isDirectory()) throw new Error('Expected a real application bundle');
  const { stdout } = await run(
    '/usr/bin/plutil',
    ['-convert', 'json', '-o', '-', join(bundle, 'Contents/Info.plist')],
    commandOptions,
  );
  const info = JSON.parse(stdout);
  const schemes = info.CFBundleURLTypes?.flatMap((entry) => entry.CFBundleURLSchemes ?? []);
  if (
    info.CFBundleIdentifier !== 'org.openkraken.desktop' ||
    info.CFBundleExecutable !== 'openkraken' ||
    info.CFBundleShortVersionString !== version ||
    info.CFBundlePackageType !== 'APPL' ||
    !Array.isArray(schemes) ||
    schemes.length !== 1 ||
    schemes[0] !== 'openkraken'
  )
    throw new Error('macOS bundle identity, version, executable or repository scheme differs');
  await verifyFuses(bundle);
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], commandOptions);
  if (identity) await verifyMacSignature(bundle, identity, 'org.openkraken.desktop');
}

export async function buildDmg(bundle, work, filename, version, identity) {
  requireMac();
  if (basename(filename) !== filename || !filename.endsWith('.dmg'))
    throw new Error('Expected a DMG artifact basename');
  const original = await payloadManifest(bundle);
  await verifyMacBundle(bundle, version, identity);
  const source = join(work, 'dmg-source');
  await mkdir(source);
  const copied = join(source, 'OpenKraken.app');
  await run('/usr/bin/ditto', [bundle, copied], commandOptions);
  comparePayload(original, await payloadManifest(copied));
  await verifyMacBundle(copied, version, identity);
  await symlink('/Applications', join(source, 'Applications'));
  const artifact = join(work, filename);
  await run(
    '/usr/bin/hdiutil',
    [
      'create',
      '-fs',
      'HFS+',
      '-format',
      'UDZO',
      '-volname',
      'OpenKraken',
      '-srcfolder',
      source,
      artifact,
    ],
    commandOptions,
  );
  comparePayload(original, await payloadManifest(bundle));
  if (identity) await signDiskImage(artifact, identity);
  return artifact;
}

// Own this temporary directory separately from the Linux extractor: a failed
// attach/detach must never lead to recursive cleanup of a mounted filesystem.
export async function verifyDmg(source, manifest, identity) {
  requireMac();
  await mkdir('release', { recursive: true });
  const temporary = await mkdtemp(resolve('release/dmg-check-'));
  const mountpoint = join(temporary, 'mounted');
  const installed = join(temporary, 'installed');
  const copied = join(installed, 'OpenKraken.app');
  let safeToRemove = true;
  try {
    // Keep the checked bytes stable across verification and attachment.
    const artifact = join(temporary, 'candidate.dmg');
    await copyFile(source, artifact);
    if (
      (await stat(artifact)).size !== manifest.artifact.size ||
      (await sha256(artifact)) !== manifest.artifact.sha256
    )
      throw new Error('Installer checksum or size mismatch');
    if (identity) await verifyMacSignature(artifact, identity, 'org.openkraken.desktop.dmg');
    if (manifest.notarySubmissionId) await verifyNotaryTicket(artifact);
    await mkdir(mountpoint);
    await mkdir(installed);
    // If attach fails after mounting, preserve the directory for inspection.
    safeToRemove = false;
    await run(
      '/usr/bin/hdiutil',
      ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mountpoint, artifact],
      commandOptions,
    );
    try {
      if ((await readlink(join(mountpoint, 'Applications'))) !== '/Applications')
        throw new Error('DMG Applications shortcut differs');
      const mounted = join(mountpoint, 'OpenKraken.app');
      comparePayload(manifest.payload, await payloadManifest(mounted));
      await verifyMacBundle(mounted, manifest.version, identity);
      verifyPackagedApplication(mounted, manifest.version, manifest.source ?? null);
      await run('/usr/bin/ditto', [mounted, copied], commandOptions);
      comparePayload(manifest.payload, await payloadManifest(copied));
      await verifyMacBundle(copied, manifest.version, identity);
    } finally {
      // Do not force-unmount or kill unrelated processes to clean up a failure.
      await run('/usr/bin/hdiutil', ['detach', mountpoint], commandOptions);
      safeToRemove = true;
    }
    console.log(
      'DMG payload, bundle metadata, signature and Electron fuses verified; image detached',
    );
    const smoke = spawn(process.execPath, ['scripts/smoke-package.mjs', '--history'], {
      stdio: 'inherit',
      env: {
        ...process.env,
        OPENKRAKEN_PACKAGE_DIRECTORY: installed,
        OPENKRAKEN_PACKAGE_EXECUTABLE: join(copied, 'Contents/MacOS/openkraken'),
      },
    });
    await new Promise((resolve, reject) => {
      smoke.once('error', reject);
      smoke.once('exit', (code, signal) =>
        code === 0
          ? resolve()
          : reject(new Error(`DMG installed application smoke failed: ${code ?? signal}`)),
      );
    });
    console.log('Verified DMG copy-install and launch after detach');
  } finally {
    if (safeToRemove) await rm(temporary, { recursive: true, force: true });
    else
      console.error(`DMG mount state uncertain; retained ${temporary}. Detach before removing it.`);
  }
}
