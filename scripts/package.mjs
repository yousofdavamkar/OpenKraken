import { packager } from '@electron/packager';
import { macPackagerOptions } from './mac-bundle-versions.mjs';
import { flipFuses, FuseVersion } from '@electron/fuses';
import {
  packageFuses,
  pinnedElectronRuntime,
  payloadManifest,
  verifyFuses,
} from './package-security.mjs';
import { buildLinuxNative } from './linux-native.mjs';
import { mkdir, readFile, writeFile, rm, lstat, readdir, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  authenticode,
  verifyWindowsArchiveSignatures,
  windowsSignedArchivePaths,
  windowsIdentity,
  windowsTimestamp,
} from './msi.mjs';
import { execFileSync } from 'node:child_process';
const workspace = resolve(import.meta.dirname, '..');
function readBuildSource() {
  const git = (args) =>
    execFileSync('git', args, {
      cwd: workspace,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  try {
    return {
      commit: git(['rev-parse', '--verify', 'HEAD']).trim(),
      dirty: Boolean(git(['status', '--porcelain'])),
    };
  } catch {
    // A source export can be packaged without its Git checkout.
    return null;
  }
}
const { values } = parseArgs({
  options: { 'win-identity': { type: 'string' }, 'win-timestamp-url': { type: 'string' } },
});
const winIdentity = windowsIdentity(
  process.platform === 'win32' && process.arch === 'x64' ? 'msi' : process.platform,
  values['win-identity'],
);
const timestampUrl = windowsTimestamp(winIdentity, values['win-timestamp-url']);
const source = readBuildSource();
const staging = resolve('release/staging');
const release = JSON.parse(await readFile('package.json', 'utf8'));
const { version } = release;
const macOptions = process.platform === 'darwin' ? macPackagerOptions(release) : {};
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
execFileSync(process.execPath, [join(import.meta.dirname, 'build.mjs'), join(staging, 'dist')], {
  cwd: workspace,
  stdio: 'inherit',
});
await buildLinuxNative(staging);
// Electron records unpacked file sizes and digests when it creates the ASAR.
if (winIdentity) {
  for (const name of windowsSignedArchivePaths) {
    await authenticode(join(staging, name), winIdentity, { sign: true, timestampUrl });
  }
}
await writeFile(
  join(staging, 'package.json'),
  JSON.stringify({
    name: 'openkraken',
    productName: 'OpenKraken',
    version,
    main: 'dist/main.cjs',
    desktopName: 'openkraken.desktop',
    openkrakenSource: source,
  }),
);
const outputs = await packager({
  dir: staging,
  out: 'release',
  name: 'OpenKraken',
  appBundleId: 'org.openkraken.desktop',
  executableName: 'openkraken',
  ...pinnedElectronRuntime(),
  ...macOptions,
  protocols: [{ name: 'OpenKraken repository links', schemes: ['openkraken'] }],
  asar: {
    unpack: '**/*.node',
    unpackDir: 'dist/{helpers,node_modules/node-pty,shell-integration}',
  },
  overwrite: true,
});
for (const output of outputs) {
  if (process.platform !== 'win32') {
    // Electron's ZIP permissions can be 0666/0777. Never ship an executable or
    // ASAR writable by other accounts, regardless of the builder's umask.
    async function normalizeModes(path) {
      const info = await lstat(path);
      if (info.isSymbolicLink()) return;
      await chmod(path, info.isDirectory() || info.mode & 0o111 ? 0o755 : 0o644);
      if (info.isDirectory())
        for (const name of await readdir(path)) await normalizeModes(join(path, name));
    }
    await normalizeModes(output);
  }
  const binary =
    process.platform === 'darwin'
      ? join(output, 'OpenKraken.app')
      : join(output, process.platform === 'win32' ? 'openkraken.exe' : 'openkraken');
  await flipFuses(binary, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: process.platform === 'darwin',
    ...packageFuses,
  });
  if (winIdentity) {
    await verifyWindowsArchiveSignatures(join(output, 'resources'), winIdentity, {
      requireTimestamp: !!timestampUrl,
    });
    await authenticode(binary, winIdentity, { sign: true, timestampUrl });
  }
  await verifyFuses(binary);
  if (process.platform === 'win32') await payloadManifest(output);
  console.log(`Packaged and verified fuses: ${output}`);
}
