import { spawn } from 'node:child_process';

export class GitError extends Error {
  constructor(
    public code: string,
    message: string,
    public exitCode?: number,
  ) {
    super(message);
  }
}
export interface RunOptions {
  cwd?: string;
  signal?: AbortSignal;
  stdin?: string | Buffer;
  readOnly?: boolean;
  maxBytes?: number;
  timeoutMs?: number;
  onStdout?: (chunk: Buffer) => void | Promise<void>;
  allowedExitCodes?: number[];
  env?: NodeJS.ProcessEnv;
  /** Trusted service-owned alternate index; never sourced from renderer or shell env. */
  indexFile?: string;
}
/** No shell. Bounded total output even when streaming; wait for close before releasing locks. */
export function runProcess(
  executable: string,
  args: string[],
  options: RunOptions = {},
): Promise<{ stdout: Buffer; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new GitError('CANCELLED', 'Operation cancelled'));
      return;
    }
    const env = { ...process.env, ...options.env };
    // A caller's shell repository selection must not override the chosen folder.
    for (const key of Object.keys(env))
      if (
        /^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG_COUNT|CONFIG_KEY_.*|CONFIG_VALUE_.*|CONFIG_PARAMETERS)$/.test(
          key,
        )
      )
        delete env[key];
    if (options.indexFile) env.GIT_INDEX_FILE = options.indexFile;
    delete env.GIT_SSL_NO_VERIFY;
    env.LC_ALL = 'C';
    env.GIT_TERMINAL_PROMPT = '0';
    env.GIT_PAGER = 'cat';
    if (options.readOnly !== false) env.GIT_OPTIONAL_LOCKS = '0';
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [],
      stderr: Buffer[] = [];
    let bytes = 0,
      failure: Error | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const killGroup = (force: boolean) => {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
        killer.on('error', () => child.kill());
      } else {
        try {
          process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
        } catch {}
      }
    };
    const stop = (error: Error) => {
      if (failure) return;
      failure = error;
      killGroup(false);
      escalation = setTimeout(() => killGroup(true), 200);
      escalation.unref();
    };
    const abort = () => stop(new GitError('CANCELLED', 'Operation cancelled'));
    options.signal?.addEventListener('abort', abort, { once: true });
    let delivery = Promise.resolve();
    const timer =
      options.timeoutMs === 0
        ? undefined
        : setTimeout(
            () => stop(new GitError('TIMEOUT', 'Git operation timed out')),
            options.timeoutMs ?? 30000,
          );
    const consume = (chunk: Buffer, isOut: boolean) => {
      if (failure) return;
      bytes += chunk.length;
      if (bytes > (options.maxBytes ?? 32 * 1024 * 1024)) {
        stop(new GitError('OUTPUT_LIMIT', 'Git output exceeded the safety limit'));
        return;
      }
      try {
        if (isOut && options.onStdout) return options.onStdout(chunk);
        else (isOut ? stdout : stderr).push(chunk);
      } catch (error) {
        stop(error instanceof Error ? error : new Error(String(error)));
      }
    };
    child.stdout.on('data', (chunk: Buffer) => {
      child.stdout.pause();
      delivery = Promise.resolve()
        .then(() => consume(chunk, true))
        .catch((error) => {
          stop(error instanceof Error ? error : new Error(String(error)));
        })
        .finally(() => child.stdout.resume());
    });
    child.stderr.on('data', (chunk: Buffer) => consume(chunk, false));
    child.on('error', (error) => {
      failure ??= error;
    });
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') stop(error);
    });
    child.on('close', async (code) => {
      await delivery;
      clearTimeout(timer);
      if (escalation) clearTimeout(escalation);
      options.signal?.removeEventListener('abort', abort);
      const err = Buffer.concat(stderr).toString('utf8');
      if (failure) reject(failure);
      else if (!(options.allowedExitCodes ?? [0]).includes(code ?? -1))
        reject(new GitError('GIT_FAILED', err.trim() || `Process exited with ${code}`, code ?? -1));
      else resolve({ stdout: Buffer.concat(stdout), stderr: err, exitCode: code ?? -1 });
    });
    child.stdin.end(options.stdin);
  });
}
export function runGit(git: string, args: string[], options: RunOptions = {}) {
  return runProcess(
    git,
    [
      '--no-pager',
      '-c',
      'core.quotepath=false',
      '-c',
      'color.ui=false',
      '-c',
      'log.showSignature=false',
      '-c',
      'gc.auto=0',
      '-c',
      'maintenance.auto=false',
      '-c',
      'http.sslVerify=true',
      ...args,
    ],
    options,
  );
}
export async function locateGit(bundledPath?: string): Promise<{ path: string; version: string }> {
  const candidates = bundledPath ? [bundledPath, 'git'] : ['git'];
  const errors: string[] = [];
  for (const path of candidates) {
    try {
      const { stdout } = await runProcess(path, ['--version'], { timeoutMs: 5000, maxBytes: 4096 });
      const match = /git version (\d+)\.(\d+)\.(\d+)/.exec(stdout.toString());
      if (!match || Number(match[1]) < 2 || (Number(match[1]) === 2 && Number(match[2]) < 38))
        throw new Error('Git 2.38 or later is required');
      return { path, version: match[0].slice(12) };
    } catch (error) {
      errors.push(String(error));
    }
  }
  throw new GitError('GIT_NOT_FOUND', `Install Git 2.38 or later. ${errors.join('; ')}`);
}
