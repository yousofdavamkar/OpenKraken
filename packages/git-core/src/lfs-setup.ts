import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { LfsSetupPreview, Repository } from '@openkraken/ipc-contract';
import { GitError, type RunOptions, type runGit } from './runner.js';
import { redactGitMessage } from './progress.js';

type Run = (args: string[], options?: RunOptions) => ReturnType<typeof runGit>;
const hooks = ['pre-push', 'post-checkout', 'post-commit', 'post-merge'];
const filterPattern = '^filter\\.lfs\\.(clean|smudge|process|required)$';
function filterEntries(output: Buffer): [string, string][] {
  const text = output.toString('utf8');
  if (!Buffer.from(text).equals(output))
    throw new GitError('LFS_SETUP_CONFIG', 'LFS filter configuration must use UTF-8');
  return text
    .split('\0')
    .filter(Boolean)
    .flatMap((record) => {
      const separator = record.indexOf('\n');
      const key = record.slice(0, separator);
      return new RegExp(filterPattern).test(key)
        ? [[key, record.slice(separator + 1)] as [string, string]]
        : [];
    });
}
export interface LfsSetupPlan {
  token: string;
  fingerprint: string;
  skipSmudge: boolean;
  expiresAt: number;
  filters: [string, string][];
}

// Configuration and hooks must be small regular files; do not follow leaf symlinks.
async function file(path: string, limit: number, signal?: AbortSignal) {
  let before;
  try {
    before = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!before.isFile() || before.size > limit)
    throw new GitError(
      'LFS_SETUP_PATH',
      'LFS setup requires regular, bounded configuration and hook files. Manage custom paths manually.',
    );
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const data = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < data.length) {
      if (signal?.aborted) throw new GitError('CANCELLED', 'Operation cancelled');
      const { bytesRead } = await handle.read(data, length, data.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    if (
      length > limit ||
      after.ino !== before.ino ||
      after.dev !== before.dev ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw new GitError(
        'STALE_LFS_SETUP',
        'Configuration or hooks changed during inspection. Review setup again.',
      );
    return { bytes: data.subarray(0, length), mode: after.mode };
  } finally {
    await handle.close();
  }
}

async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return resolve(await canonical(parent), basename(path));
  }
}

export class LfsSetup {
  constructor(
    private repo: Repository,
    private run: Run,
    private plans: Map<string, LfsSetupPlan>,
  ) {}
  private async inspect(signal?: AbortSignal) {
    if (this.repo.isBare)
      throw new GitError('BARE_REPOSITORY', 'Open a working checkout before setting up LFS');
    const version = (await this.run(['lfs', 'version'], { signal, maxBytes: 4096 })).stdout
      .toString()
      .trim();
    if (Number(/^git-lfs\/(\d+)\./.exec(version)?.[1] ?? 0) < 3)
      throw new GitError('LFS_VERSION', 'Git LFS 3 or newer is required for setup');
    const worktree = await this.run(['config', '--bool', '--get', 'extensions.worktreeConfig'], {
      signal,
      allowedExitCodes: [0, 1],
      maxBytes: 4096,
    });
    const scope =
      worktree.stdout.toString().trim() === 'true'
        ? ('worktree' as const)
        : ('repository' as const);
    const configPath = join(
      scope === 'worktree' ? this.repo.gitDir : this.repo.commonDir,
      scope === 'worktree' ? 'config.worktree' : 'config',
    );
    const config = await file(configPath, 1024 * 1024, signal);
    const commonConfig = await file(join(this.repo.commonDir, 'config'), 1024 * 1024, signal);
    const effective = (
      await this.run(['config', '--null', '--list'], { signal, maxBytes: 2 * 1024 * 1024 })
    ).stdout;
    const scoped = await this.run(
      [
        'config',
        scope === 'worktree' ? '--worktree' : '--local',
        '--includes',
        '--null',
        '--get-regexp',
        filterPattern,
      ],
      { signal, allowedExitCodes: [0, 1], maxBytes: 65536 },
    );
    const filters = filterEntries(scoped.stdout);
    if (filters.length > 32)
      throw new GitError(
        'LFS_SETUP_CONFIG',
        'Too many LFS filter definitions. Consolidate them before setup.',
      );
    const nativePath = (
      await this.run(['rev-parse', '--path-format=absolute', '--git-path', 'hooks'], {
        signal,
        maxBytes: 32768,
      })
    ).stdout
      .toString()
      .replace(/\r?\n$/, '');
    const hooksPath = await canonical(nativePath);
    try {
      if (!(await lstat(hooksPath)).isDirectory())
        throw new GitError('LFS_SETUP_PATH', 'The hooks location must be a directory');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const existing = await Promise.all(
      hooks.map((hook) => file(join(hooksPath, hook), 1024, signal)),
    );
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          version,
          scope,
          configPath,
          hooksPath,
          effective,
          filters,
          config,
          commonConfig,
          existing,
        }),
      )
      .digest('hex');
    return { scope, configPath, hooksPath, filters, existing, fingerprint };
  }
  private async rehearse(
    inspected: Awaited<ReturnType<LfsSetup['inspect']>>,
    skipSmudge: boolean,
    signal?: AbortSignal,
  ) {
    const scratch = await mkdtemp(join(tmpdir(), 'openkraken-lfs-setup-'));
    try {
      // Native setup can also normalize LFS metadata. Rehearse in an isolated
      // repository, not merely with an alternate hook directory.
      await this.run(['-c', 'init.templateDir=', 'init', '--quiet', scratch], {
        signal,
        readOnly: false,
        maxBytes: 65536,
      });
      const isolated = [
        `--git-dir=${join(scratch, '.git')}`,
        `--work-tree=${scratch}`,
        '-c',
        `lfs.storage=${join(scratch, 'lfs')}`,
      ];
      const config = join(scratch, '.git/config');
      const hookDir = join(scratch, 'hooks');
      // Resolve includes in the original repository, then copy only filter
      // settings. Relative/conditional includes must not resolve against scratch.
      for (const [key, value] of inspected.filters)
        await this.run([...isolated, 'config', '--file', config, '--add', '--', key, value], {
          signal,
          readOnly: false,
          maxBytes: 65536,
        });
      await mkdir(hookDir);
      for (const [index, hook] of hooks.entries()) {
        const entry = inspected.existing[index];
        if (entry) await writeFile(join(hookDir, hook), entry.bytes, { mode: entry.mode & 0o777 });
      }
      const installed = await this.run(
        [
          ...isolated,
          'lfs',
          'install',
          '--local',
          '--skip-repo',
          ...(skipSmudge ? ['--skip-smudge'] : []),
        ],
        { signal, readOnly: false, maxBytes: 65536, allowedExitCodes: [0, 2] },
      );
      if (installed.exitCode)
        throw new GitError(
          'LFS_SETUP_CONFLICT',
          redactGitMessage(installed.stdout.toString() + installed.stderr).slice(0, 8192),
        );
      await this.run([...isolated, '-c', `core.hooksPath=${hookDir}`, 'lfs', 'update'], {
        signal,
        readOnly: false,
        maxBytes: 65536,
      });
      if (process.platform !== 'win32')
        for (const hook of hooks) {
          if (!((await lstat(join(hookDir, hook))).mode & 0o111))
            throw new GitError(
              'LFS_HOOK_PERMISSIONS',
              'An LFS hook is not executable. Restore its executable permissions before setup.',
            );
        }
      return filterEntries(
        (
          await this.run(
            [...isolated, 'config', '--file', config, '--null', '--get-regexp', filterPattern],
            { signal, maxBytes: 65536 },
          )
        ).stdout,
      );
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
  async preview(skipSmudge: boolean, signal?: AbortSignal): Promise<LfsSetupPreview> {
    const inspected = await this.inspect(signal);
    const filters = await this.rehearse(inspected, skipSmudge, signal);
    const token = randomUUID();
    for (const [key, plan] of this.plans) if (plan.expiresAt < Date.now()) this.plans.delete(key);
    if (this.plans.size >= 32) this.plans.delete(this.plans.keys().next().value!);
    this.plans.set(this.repo.id, {
      token,
      fingerprint: inspected.fingerprint,
      skipSmudge,
      expiresAt: Date.now() + 600000,
      filters,
    });
    return {
      token,
      scope: inspected.scope,
      configPath: inspected.configPath,
      hooksPath: inspected.hooksPath,
      skipSmudge,
    };
  }
  async install(token: string, signal?: AbortSignal) {
    const plan = this.plans.get(this.repo.id);
    if (!plan || plan.token !== token || plan.expiresAt < Date.now())
      throw new GitError('STALE_LFS_SETUP', 'Review LFS setup again before continuing');
    this.plans.delete(this.repo.id);
    const inspected = await this.inspect(signal);
    if (inspected.fingerprint !== plan.fingerprint)
      throw new GitError(
        'STALE_LFS_SETUP',
        'Configuration or hooks changed. Review LFS setup again.',
      );
    await this.run(
      [
        '-c',
        `core.hooksPath=${inspected.hooksPath}`,
        'lfs',
        'install',
        inspected.scope === 'worktree' ? '--worktree' : '--local',
        ...(plan.skipSmudge ? ['--skip-smudge'] : []),
      ],
      { signal, readOnly: false, maxBytes: 65536 },
    );
    const effective = new Map(
      filterEntries(
        (
          await this.run(['config', '--null', '--get-regexp', filterPattern], {
            signal,
            maxBytes: 65536,
            allowedExitCodes: [0, 1],
          })
        ).stdout,
      ),
    );
    if (plan.filters.some(([key, value]) => effective.get(key) !== value))
      throw new GitError(
        'LFS_SETUP_OVERRIDDEN',
        'Other Git configuration overrides the installed LFS filters. Resolve the conflicting settings and review setup again.',
      );
  }
}
