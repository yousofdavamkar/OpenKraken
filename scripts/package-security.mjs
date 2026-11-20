import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createRequire } from 'node:module';
import { lstat, readdir, readlink } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { getCurrentFuseWire, FuseV1Options, FuseState } from '@electron/fuses';
import { readWindowsPayloadAccess } from './windows-payload.mjs';

const require = createRequire(import.meta.url);
const { extractFile, statFile } = createRequire(require.resolve('@electron/packager'))(
  '@electron/asar',
);

// The locked Electron npm package publishes the checksums for its release archives.
export function pinnedElectronRuntime() {
  return {
    electronVersion: require('electron/package.json').version,
    download: { checksums: require('electron/checksums.json') },
  };
}

export function verifyPackagedApplication(directory, version, claimedSource) {
  const resources = process.platform === 'darwin' ? 'Contents/Resources' : 'resources';
  const archive = join(directory, resources, 'app.asar');
  const app = JSON.parse(extractFile(archive, 'package.json').toString('utf8'));
  if (
    typeof version !== 'string' ||
    !version ||
    app.version !== version ||
    app.name !== 'openkraken' ||
    app.desktopName !== 'openkraken.desktop' ||
    app.main !== 'dist/main.cjs'
  )
    throw new Error(
      'Packaged application identity or version differs. Rebuild the platform bundle with pnpm package.',
    );
  const source = app.openkrakenSource;
  if (
    source !== null &&
    source !== undefined &&
    (typeof source.commit !== 'string' ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(source.commit) ||
      typeof source.dirty !== 'boolean')
  )
    throw new Error('Invalid packaged application source');
  // Older archives predate the embedded source record.
  if (
    source !== undefined &&
    claimedSource !== undefined &&
    (source === null
      ? claimedSource !== null
      : source.commit !== claimedSource?.commit || source.dirty !== claimedSource?.dirty)
  )
    throw new Error('Packaged application source differs from installer manifest');
  return source ? { commit: source.commit, dirty: source.dirty } : null;
}

export async function verifyAsarUnpackedFile(resources, name) {
  const entry = statFile(join(resources, 'app.asar'), name);
  const path = join(resources, 'app.asar.unpacked', name);
  const info = await lstat(path);
  if (
    !entry.unpacked ||
    !info.isFile() ||
    entry.size !== info.size ||
    entry.integrity?.algorithm !== 'SHA256' ||
    entry.integrity.hash !== (await sha256(path))
  )
    throw new Error('Unpacked file differs from its ASAR integrity record: ' + name);
}

export const packageFuses = {
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
};

export async function verifyFuses(binary) {
  const wire = await getCurrentFuseWire(binary);
  for (const [key, enabled] of Object.entries(packageFuses))
    if (wire[key] !== (enabled ? FuseState.ENABLE : FuseState.DISABLE))
      throw new Error(`Fuse ${key} verification failed`);
}

export async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

// Inspect links themselves: never follow a payload link outside its bundle.
// POSIX modes are part of the contract, including the helper's executable bit.
// Windows uses native ownership/DACL checks instead of synthetic stat modes.
export async function payloadManifest(directory) {
  const entries = {};
  const windowsAccess =
    process.platform === 'win32' ? await readWindowsPayloadAccess(directory) : null;
  async function walk(path, key) {
    const info = await lstat(path);
    const mode = info.mode & 0o7777;
    if (windowsAccess) {
      const type = info.isDirectory() ? 'directory' : info.isFile() ? 'file' : null;
      if (!type || windowsAccess.get(key) !== type)
        throw new Error(`Windows payload changed during access inspection: ${key || '.'}`);
      windowsAccess.delete(key);
    } else if (!info.isSymbolicLink() && (mode & 0o7022) !== 0)
      throw new Error(`Payload has unsafe permissions: ${key || '.'}`);
    const permissions = windowsAccess ? {} : { mode };
    if (info.isSymbolicLink()) {
      const target = await readlink(path);
      const destination = relative(directory, resolve(path, '..', target));
      if (isAbsolute(target) || destination === '..' || destination.startsWith('../'))
        throw new Error(`Payload link escapes bundle: ${key}`);
      entries[key] = { type: 'link', target };
    } else if (info.isDirectory()) {
      if (key) entries[key] = { type: 'directory', ...permissions };
      for (const name of (await readdir(path)).sort())
        await walk(join(path, name), key ? `${key}/${name}` : name);
    } else if (info.isFile()) {
      entries[key] = { type: 'file', ...permissions, size: info.size, sha256: await sha256(path) };
    } else throw new Error(`Unsupported payload entry: ${key}`);
  }
  await walk(directory, '');
  if (windowsAccess?.size) throw new Error('Windows payload changed during access inspection');
  return entries;
}

export function comparePayload(expected, actual) {
  const paths = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  for (const path of paths)
    if (JSON.stringify(expected[path]) !== JSON.stringify(actual[path]))
      throw new Error(`Installer payload differs: ${path}`);
}
