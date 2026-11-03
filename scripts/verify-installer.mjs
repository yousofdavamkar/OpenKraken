import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { comparePayload, payloadManifest, sha256, verifyFuses } from './package-security.mjs';

// RPM may omit implicit parent directory entries. Create those with safe modes,
// while -p below preserves all explicitly archived permissions for inspection.
process.umask(0o022);

// Only run this on artifacts built locally or independently authenticated.
// SHA-256 detects corruption; this adjacent manifest is not a release signature.
const manifestPath = resolve(process.argv[2] ?? '');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (
  manifest.schemaVersion !== 1 ||
  manifest.platform !== 'linux' ||
  process.platform !== manifest.platform ||
  process.arch !== manifest.arch ||
  !['deb', 'rpm'].includes(manifest.target) ||
  manifest.artifact?.file !== basename(manifest.artifact?.file ?? '') ||
  !manifest.artifact.file.endsWith(`.${manifest.target}`)
)
  throw new Error('Expected a native Linux installer manifest');
const artifact = join(dirname(manifestPath), manifest.artifact.file);
if (
  (await stat(artifact)).size !== manifest.artifact.size ||
  (await sha256(artifact)) !== manifest.artifact.sha256
)
  throw new Error('Installer checksum or size mismatch');
const run = promisify(execFile);
await mkdir('release', { recursive: true });
const temporary = await mkdtemp(resolve('release/installer-check-'));
try {
  if (manifest.target === 'deb') {
    await run('dpkg-deb', ['--extract', artifact, temporary]);
    const { stdout: dependencies } = await run('dpkg-deb', ['--field', artifact, 'Depends']);
    if (!/git \(>= 2\.38\)/.test(dependencies)) throw new Error('Git version dependency missing');
    await run('dpkg-deb', ['--control', artifact, join(temporary, 'DEBIAN')]);
    for (const script of ['postinst', 'postrm']) {
      const text = await readFile(join(temporary, 'DEBIAN', script), 'utf8');
      if (text.includes('--no-sandbox') || text.includes('--disable-sandbox'))
        throw new Error('Installer disables the Chromium sandbox');
      await run('bash', ['-n', join(temporary, 'DEBIAN', script)]);
    }
  } else {
    const { stdout: dependencies } = await run('rpm', ['-qp', '--requires', artifact]);
    if (!/^git >= 2\.38$/m.test(dependencies)) throw new Error('Git version dependency missing');
    const { stdout: scripts } = await run('rpm', ['-qp', '--scripts', artifact]);
    if (scripts.includes('--no-sandbox') || scripts.includes('--disable-sandbox'))
      throw new Error('Installer disables the Chromium sandbox');
    // No shell interpolation or root install: bsdtar reads the RPM payload directly.
    await run('bsdtar', ['-xpf', artifact, '-C', temporary]);
  }
  const directory = join(temporary, 'opt/OpenKraken');
  comparePayload(manifest.payload, await payloadManifest(directory));
  await verifyFuses(join(directory, 'openkraken'));
  const desktop = await readFile(
    join(temporary, 'usr/share/applications/openkraken.desktop'),
    'utf8',
  );
  if (
    !/^Exec=\/?opt\/OpenKraken\/openkraken(?: %U)?$/m.test(desktop) ||
    !/^Icon=openkraken$/m.test(desktop) ||
    !/^StartupWMClass=openkraken$/m.test(desktop) ||
    /--(?:no|disable)-sandbox/.test(desktop)
  )
    throw new Error('Desktop launcher does not match the sandboxed application');
  console.log('Installer payload, launch entry, Git dependency and Electron fuses verified');
  const smoke = spawn(process.execPath, ['scripts/smoke-package.mjs'], {
    stdio: 'inherit',
    env: { ...process.env, OPENKRAKEN_PACKAGE_DIRECTORY: directory },
  });
  await new Promise((resolve, reject) => {
    smoke.once('error', reject);
    smoke.once('exit', (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`Installer smoke failed: ${code ?? signal}`)),
    );
  });
  console.log(
    `Verified extracted ${manifest.target} payload; install/uninstall lifecycle is a separate gate`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
