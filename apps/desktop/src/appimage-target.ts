import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

/** Runtime paths only; never accepts renderer input or enables development installs. */
export async function appImageTarget(runtime: {
  packaged: boolean;
  platform: string;
  version: string;
  executable: string;
  image?: string;
  appdir?: string;
}): Promise<string | undefined> {
  if (
    !runtime.packaged ||
    runtime.platform !== 'linux' ||
    !runtime.image ||
    !runtime.appdir ||
    !isAbsolute(runtime.image) ||
    !isAbsolute(runtime.appdir) ||
    runtime.appdir === '/'
  )
    return;
  try {
    if (
      (await realpath(join(runtime.appdir, 'usr/lib/openkraken/openkraken'))) !==
        (await realpath(runtime.executable)) ||
      (await realpath(runtime.image)) !== runtime.image
    )
      return;
    const image = await lstat(runtime.image);
    if (!image.isFile() || image.uid !== process.getuid!() || image.nlink > 2 || image.mode & 0o022)
      return;
    const metadata = join(runtime.appdir, 'openkraken-release.json');
    const info = await lstat(metadata);
    if (!info.isFile() || info.size > 4096) return;
    if (JSON.parse(await readFile(metadata, 'utf8')).version !== runtime.version) return;
    return runtime.image;
  } catch {
    return;
  }
}
