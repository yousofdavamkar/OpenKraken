import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
export type InstalledUpdate = {
  target: string;
  sha256: string;
  size: number;
  recovery: { previous: { sha256: string; size: number }; journalSha256: string };
};
export async function prepareUpdateRestart(directory: string, source: string) {
  const folder = await lstat(directory);
  if (!folder.isDirectory() || folder.uid !== process.getuid!() || folder.mode & 0o077)
    throw new Error('Unavailable restart directory');
  const helper = join(directory, 'restart-helper');
  const temporary = join(directory, 'restart-helper.tmp');
  for (const path of [helper, temporary]) {
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (
      info &&
      (!info.isFile() ||
        info.uid !== process.getuid!() ||
        info.nlink !== 1 ||
        info.size > 16 * 1024 * 1024 ||
        info.mode & 0o077)
    )
      throw new Error('Unavailable restart helper');
    if (info && path === temporary) await unlink(path);
  }
  const info = await lstat(source);
  if (!info.isFile() || info.size > 16 * 1024 * 1024) throw new Error('Unavailable bundled helper');
  const data = await readFile(source);
  if (data.length !== info.size) throw new Error('Changed bundled helper');
  const file = await open(temporary, 'wx', 0o700);
  try {
    await file.writeFile(data);
    await file.sync();
  } finally {
    await file.close();
  }
  if (hash(await readFile(temporary)) !== hash(data)) throw new Error('Changed restart helper');
  await rename(temporary, helper);
  return helper;
}

export function launchUpdateAfterExit(helper: string, update: InstalledUpdate, profile: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(
      helper,
      [
        '--relaunch',
        String(process.pid),
        update.target,
        profile,
        update.sha256,
        String(update.size),
        update.recovery.previous.sha256,
        String(update.recovery.previous.size),
        update.recovery.journalSha256,
      ],
      { detached: true, stdio: ['pipe', 'pipe', 'ignore'] },
    );
    let settled = false;
    let ready = false;
    let output = '';
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.destroy();
      if (error) {
        child.stdin.destroy();
        child.kill();
        reject(error);
      } else {
        child.unref();
        resolve();
      }
    };
    const timer = setTimeout(() => finish(new Error('Restart helper did not become ready')), 750);
    child.stdout.on('data', (data: Buffer) => {
      output += data.toString('utf8');
      if (!ready && output.startsWith('ready\n')) {
        ready = true;
        output = output.slice(6);
        child.stdin.end('launch\n');
      }
      if (ready && output === 'armed\n') finish();
      else if (output.length > 16) finish(new Error('Invalid restart helper response'));
    });
    child.stdin.on('error', () => finish(new Error('Restart helper connection failed')));
    child.once('error', () => finish(new Error('Restart helper failed to start')));
    child.once('exit', () => finish(new Error('Restart helper stopped')));
  });
}
