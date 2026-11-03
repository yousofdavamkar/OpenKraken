import { z } from 'zod';
import { lfsStateSchema, type LfsState } from '@openkraken/ipc-contract';
import { GitError, type RunOptions, type runGit } from './runner.js';
import { redactGitMessage } from './progress.js';

type Run = (args: string[], options?: RunOptions) => ReturnType<typeof runGit>;
const nativeFiles = z.object({
  files: z
    .array(
      z.object({
        name: lfsStateSchema.shape.files.element.shape.path,
        oid_type: z.literal('sha256'),
        oid: lfsStateSchema.shape.files.element.shape.oid,
        size: z.number().int().nonnegative(),
        checkout: z.boolean(),
        downloaded: z.boolean(),
      }),
    )
    .max(10000)
    .nullable()
    .transform((files) => files ?? []),
});
const nativeLocks = z
  .array(
    z.object({
      id: z.string().min(1).max(4096),
      path: lfsStateSchema.shape.files.element.shape.path,
      owner: z.object({ name: z.string().max(4096) }).optional(),
      locked_at: z.string().max(128).optional(),
    }),
  )
  .max(10000);

export function parseLfsLocks(output: Buffer): LfsState['locks'] {
  try {
    const locks = nativeLocks.parse(JSON.parse(output.toString('utf8')));
    if (
      locks.some((lock) => !lock.path) ||
      new Set(locks.map((lock) => lock.id)).size !== locks.length
    )
      throw new Error('Invalid lock identities');
    return locks.map((lock) => ({
      id: lock.id,
      path: lock.path,
      owner: lock.owner?.name,
      lockedAt: lock.locked_at,
    }));
  } catch {
    throw new GitError('LFS_LOCK_OUTPUT', 'Git LFS returned invalid or excessive lock information');
  }
}

export async function lfsState(run: Run, signal?: AbortSignal): Promise<LfsState> {
  const version = await run(['lfs', 'version'], {
    signal,
    maxBytes: 4096,
    allowedExitCodes: [0, 1],
  });
  if (version.exitCode) {
    if (/git: 'lfs' is not a git command/.test(version.stderr))
      return { available: false, files: [], locks: [] };
    throw new GitError('LFS_UNAVAILABLE', redactGitMessage(version.stderr));
  }
  const name = version.stdout.toString('utf8').trim();
  if (Number(/^git-lfs\/(\d+)\./.exec(name)?.[1] ?? 0) < 3)
    throw new GitError(
      'LFS_VERSION',
      'Git LFS 3 or newer is required for file and cached-lock inspection',
    );
  const output = await run(['lfs', 'ls-files', '--json'], { signal, maxBytes: 16 * 1024 * 1024 });
  let files: LfsState['files'];
  try {
    files = nativeFiles.parse(JSON.parse(output.stdout.toString('utf8'))).files.map((file) => ({
      path: file.name,
      oid: file.oid,
      size: file.size,
      checkout: file.checkout,
      downloaded: file.downloaded,
    }));
  } catch {
    throw new GitError('LFS_OUTPUT', 'Git LFS returned invalid or excessive file information');
  }
  let locks: LfsState['locks'] = [];
  let lockError: string | undefined;
  try {
    const cached = await run(['lfs', 'locks', '--cached', '--json'], {
      signal,
      maxBytes: 8 * 1024 * 1024,
    });
    locks = parseLfsLocks(cached.stdout);
  } catch (error) {
    if (signal?.aborted || (error instanceof GitError && error.code === 'CANCELLED')) throw error;
    lockError =
      error instanceof GitError
        ? redactGitMessage(error.message).slice(0, 4096)
        : 'Git LFS returned invalid or excessive cached lock information';
  }
  return lfsStateSchema.parse({ available: true, version: name, files, locks, lockError });
}
