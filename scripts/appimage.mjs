import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, cp, mkdir, open, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { sha256 } from './package-security.mjs';

const run = promisify(execFile);
// Digests from the official GitHub release asset metadata. Never execute an
// unverified download or silently fall back to a mutable continuous release.
const releases = {
  x64: {
    arch: 'x86_64',
    tool: 'ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0',
    runtime: '2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d',
  },
  arm64: {
    arch: 'aarch64',
    tool: 'f0837e7448a0c1e4e650a93bb3e85802546e60654ef287576f46c71c126a9158',
    runtime: '00cbdfcf917cc6c0ff6d3347d59e0ca1f7f45a6df1a428a0d6d8a78664d87444',
  },
};

async function download(url, digest) {
  const cache = resolve('release/appimage-tools');
  await mkdir(cache, { recursive: true });
  const path = join(cache, digest);
  const existing = await stat(path).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (!existing) {
    const temporary = `${path}.${randomUUID()}`;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
      if (!response.ok || !response.url.startsWith('https://'))
        throw new Error(`AppImage tool download failed: ${response.status}`);
      const file = await open(temporary, 'wx', 0o600);
      try {
        let bytes = 0;
        for await (const chunk of response.body) {
          bytes += chunk.length;
          if (bytes > 32 * 1024 * 1024) throw new Error('AppImage tool download exceeds size cap');
          await file.writeFile(chunk);
        }
      } finally {
        await file.close();
      }
      if ((await sha256(temporary)) !== digest) throw new Error('AppImage tool checksum mismatch');
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  if ((await sha256(path)) !== digest) throw new Error('Cached AppImage tool checksum mismatch');
  await chmod(path, 0o755);
  return path;
}

export async function buildAppImage(prepackaged, work, name, releaseInfo) {
  const release = releases[process.arch];
  const tool = await download(
    `https://github.com/AppImage/appimagetool/releases/download/1.9.1/appimagetool-${release.arch}.AppImage`,
    release.tool,
  );
  const runtime = await download(
    `https://github.com/AppImage/type2-runtime/releases/download/20251108/runtime-${release.arch}`,
    release.runtime,
  );
  const appdir = join(work, 'OpenKraken.AppDir');
  await mkdir(join(appdir, 'usr/lib'), { recursive: true });
  await cp(prepackaged, join(appdir, 'usr/lib/openkraken'), {
    recursive: true,
    verbatimSymlinks: true,
  });
  await cp('build-resources/AppRun', join(appdir, 'AppRun'));
  await chmod(join(appdir, 'AppRun'), 0o755);
  await cp('build-resources/openkraken.png', join(appdir, 'openkraken.png'));
  await chmod(join(appdir, 'openkraken.png'), 0o644);
  await symlink('openkraken.png', join(appdir, '.DirIcon'));
  await cp(
    'build-resources/appimage-runtime-LICENSE.txt',
    join(appdir, 'appimage-runtime-LICENSE.txt'),
  );
  await chmod(join(appdir, 'appimage-runtime-LICENSE.txt'), 0o644);
  await writeFile(
    join(appdir, 'openkraken-release.json'),
    JSON.stringify(releaseInfo, null, 2) + '\n',
  );
  await writeFile(
    join(appdir, 'openkraken.desktop'),
    '[Desktop Entry]\nType=Application\nName=OpenKraken\nExec=AppRun %U\nIcon=openkraken\nCategories=Development;\nTerminal=false\nStartupWMClass=openkraken\n',
  );
  const artifact = join(work, name);
  const { stdout, stderr } = await run(
    tool,
    ['--appimage-extract-and-run', '--runtime-file', runtime, '--no-appstream', appdir, artifact],
    { env: { ...process.env, ARCH: release.arch, TMPDIR: work }, maxBuffer: 8 * 1024 * 1024 },
  );
  console.log(stdout + stderr);
  await chmod(artifact, 0o755);
  return { artifact, appdir };
}
