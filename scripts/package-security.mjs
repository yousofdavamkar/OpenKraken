import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readlink } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { getCurrentFuseWire, FuseV1Options, FuseState } from '@electron/fuses';

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
// Modes are part of the contract, including the native helper's executable bit.
export async function payloadManifest(directory) {
  const entries = {};
  async function walk(path, key) {
    const info = await lstat(path);
    const mode = info.mode & 0o7777;
    if (!info.isSymbolicLink() && (mode & 0o7022) !== 0)
      throw new Error(`Payload has unsafe permissions: ${key || '.'}`);
    if (info.isSymbolicLink()) {
      const target = await readlink(path);
      const destination = relative(directory, resolve(path, '..', target));
      if (isAbsolute(target) || destination === '..' || destination.startsWith('../'))
        throw new Error(`Payload link escapes bundle: ${key}`);
      entries[key] = { type: 'link', target };
    } else if (info.isDirectory()) {
      if (key) entries[key] = { type: 'directory', mode };
      for (const name of (await readdir(path)).sort())
        await walk(join(path, name), key ? `${key}/${name}` : name);
    } else if (info.isFile()) {
      entries[key] = { type: 'file', mode, size: info.size, sha256: await sha256(path) };
    } else throw new Error(`Unsupported payload entry: ${key}`);
  }
  await walk(directory, '');
  return entries;
}

export function comparePayload(expected, actual) {
  const paths = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  for (const path of paths)
    if (JSON.stringify(expected[path]) !== JSON.stringify(actual[path]))
      throw new Error(`Installer payload differs: ${path}`);
}
