import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, copyFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const exec = promisify(execFile);
export async function locateGo() {
  const cached = join(
    homedir(),
    '.cache',
    'openkraken-tools',
    'go',
    'bin',
    process.platform === 'win32' ? 'go.exe' : 'go',
  );
  let go = process.env.OPENKRAKEN_GO ?? 'go';
  if (!process.env.OPENKRAKEN_GO) {
    try {
      await exec(go, ['version']);
    } catch {
      await access(cached);
      go = cached;
    }
  }
  return go;
}
export async function buildAskpass() {
  const go = await locateGo();
  const output = resolve('apps/desktop/dist/helpers');
  await mkdir(output, { recursive: true });
  await exec(
    go,
    [
      'build',
      '-trimpath',
      '-ldflags=-s -w',
      '-o',
      join(output, process.platform === 'win32' ? 'openkraken-askpass.exe' : 'openkraken-askpass'),
      '.',
    ],
    {
      cwd: resolve('apps/askpass'),
      env: {
        ...process.env,
        CGO_ENABLED: '0',
        GOTOOLCHAIN: 'local',
        GOOS: process.platform === 'win32' ? 'windows' : process.platform,
        GOARCH: process.arch === 'x64' ? 'amd64' : process.arch,
      },
    },
  );
  const { stdout } = await exec(go, ['env', 'GOROOT']);
  await copyFile(join(stdout.trim(), 'LICENSE'), join(output, 'Go-LICENSE.txt'));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await buildAskpass();
