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

export type PreparedUpdateLaunch = {
  arm(): Promise<void>;
  finishCommit(): void;
  cancel(): Promise<void>;
};

/** Start the trusted helper while the old app and installed image are intact. */
export function prepareUpdateLaunch(
  helper: string,
  update: InstalledUpdate,
  profile: string,
  signal?: AbortSignal,
): Promise<PreparedUpdateLaunch> {
  if (signal?.aborted) return Promise.reject(new Error('Restart helper preparation cancelled'));
  return new Promise((resolve, reject) => {
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
    let phase: 'starting' | 'ready' | 'arming' | 'armed' | 'failed' = 'starting';
    let failure: Error | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let armPromise: Promise<void> | undefined;
    let armed: (() => void) | undefined;
    let armFailed: ((error: Error) => void) | undefined;
    let closed!: () => void;
    const stopped = new Promise<void>((done) => {
      closed = done;
    });
    let output = '';
    const abort = () => fail(new Error('Restart helper preparation cancelled'));
    const fail = (error: Error) => {
      if (failure) return;
      failure = error;
      phase = 'failed';
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      child.stdout.destroy();
      child.stdin.destroy();
      // The parent is still alive, so this helper cannot have launched an app.
      child.kill('SIGKILL');
      reject(error);
      armFailed?.(error);
    };
    const prepared: PreparedUpdateLaunch = {
      arm() {
        if (failure) return Promise.reject(failure);
        if (armPromise) return armPromise;
        if (phase !== 'ready') return Promise.reject(new Error('Restart helper is not ready'));
        phase = 'arming';
        armPromise = new Promise<void>((done, failed) => {
          armed = done;
          armFailed = failed;
          timer = setTimeout(() => fail(new Error('Restart helper did not arm')), 750);
          child.stdin.write('launch\n');
        });
        return armPromise;
      },
      finishCommit() {
        child.stdin.end();
      },
      cancel() {
        fail(new Error('Restart helper preparation cancelled'));
        return stopped;
      },
    };
    timer = setTimeout(() => fail(new Error('Restart helper did not become ready')), 750);
    child.stdout.on('data', (data: Buffer) => {
      if (failure) return;
      output += data.toString('utf8');
      const expected = phase === 'starting' ? 'ready\n' : phase === 'arming' ? 'armed\n' : null;
      if (!expected || !expected.startsWith(output)) {
        fail(new Error('Invalid restart helper response'));
      } else if (output === expected) {
        output = '';
        clearTimeout(timer);
        timer = undefined;
        if (phase === 'starting') {
          phase = 'ready';
          resolve(prepared);
        } else {
          phase = 'armed';
          signal?.removeEventListener('abort', abort);
          child.stdout.destroy();
          child.unref();
          armed!();
        }
      }
    });
    child.stdout.on('error', () => fail(new Error('Restart helper connection failed')));
    child.stdin.on('error', () => fail(new Error('Restart helper connection failed')));
    child.once('error', () => {
      closed();
      fail(new Error('Restart helper failed to start'));
    });
    child.once('exit', () => {
      closed();
      fail(new Error('Restart helper stopped'));
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
