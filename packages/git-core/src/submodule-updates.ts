import { createHash, randomUUID } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Repository, SubmoduleUpdatePreview } from '@openkraken/ipc-contract';
import { GitError, type RunOptions, type runGit } from './runner.js';
import { Submodules } from './submodules.js';
import { GitProgressLines, redactGitMessage } from './progress.js';
import { transportError, validateUrl } from './remotes.js';
import { NulDecoder } from './parsers.js';

type Run = (args: string[], options: RunOptions) => ReturnType<typeof runGit>;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export interface SubmoduleUpdatePlan {
  token: string;
  fingerprint: string;
  expiresAt: number;
}
export class SubmoduleUpdates {
  constructor(
    private repo: Repository,
    private run: Run,
    private plans: Map<string, SubmoduleUpdatePlan>,
  ) {}

  private async operation(gitDir: string) {
    const names = await readdir(gitDir);
    if (
      [
        'MERGE_HEAD',
        'MERGE_AUTOSTASH',
        'CHERRY_PICK_HEAD',
        'REVERT_HEAD',
        'REBASE_HEAD',
        'BISECT_LOG',
        'sequencer',
        'rebase-merge',
        'rebase-apply',
        'index.lock',
      ].some((name) => names.includes(name))
    )
      throw new GitError(
        'SUBMODULE_OPERATION',
        'Finish the pending Git operation or index write before updating submodules',
      );
  }
  private async inspect(signal?: AbortSignal) {
    const state = await new Submodules(this.repo, this.run).list(signal);
    if (!state.entries.length)
      throw new GitError('NO_SUBMODULES', 'No submodules are registered in this checkout');
    await this.operation(this.repo.gitDir);
    const configs = new Map<string, string>();
    const revisions: string[] = [];
    const sources: SubmoduleUpdatePreview['sources'] = [];
    const tls = new Set<string>();
    const directories = new Set<string>();
    const text = async (cwd: string, args: string[], allowedExitCodes?: number[]) =>
      (await this.run(args, { cwd, signal, maxBytes: 2 * 1024 * 1024, allowedExitCodes })).stdout
        .toString('utf8')
        .replace(/\n$/, '');
    for (const entry of state.entries) {
      if (entry.state === 'conflict' || entry.state === 'unavailable')
        throw new GitError(
          'SUBMODULE_NOT_READY',
          `Resolve or repair ${entry.path} before updating submodules`,
        );
      if (entry.url) validateUrl(entry.url);
      const cwd = join(this.repo.path, entry.path);
      if (!entry.initialized) {
        try {
          if ((await readdir(cwd)).length)
            throw new GitError(
              'SUBMODULE_NOT_EMPTY',
              `Move existing files out of ${entry.path} before initializing it`,
            );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        continue;
      }
      const gitDir = await text(cwd, ['rev-parse', '--absolute-git-dir']);
      directories.add(gitDir);
      const status = await this.run(
        [
          'status',
          '--porcelain=v2',
          '-z',
          '--untracked-files=all',
          '--ignored=matching',
          '--ignore-submodules=all',
        ],
        { cwd, signal, maxBytes: 8 * 1024 * 1024 },
      );
      if (status.stdout.length)
        throw new GitError(
          'SUBMODULE_NOT_CLEAN',
          `Commit, stash or move changed, untracked and ignored files in ${entry.path} before updating`,
        );
    }
    // A deinitialized checkout can still hold staged work or detached commits in its Git directory.
    let scanned = 0;
    const visit = async (path: string, depth: number): Promise<void> => {
      if (signal?.aborted) throw new GitError('CANCELLED', 'Operation cancelled');
      if (++scanned > 10000 || depth > 32)
        throw new GitError('SUBMODULE_LIMIT', 'Stored submodule metadata is too large to review');
      let info;
      try {
        info = await lstat(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      if (info.isSymbolicLink())
        throw new GitError(
          'SUBMODULE_METADATA',
          'Repair symbolic links in stored submodule metadata before updating',
        );
      if (!info.isDirectory()) return;
      const names = await readdir(path);
      if (names.includes('HEAD') && (names.includes('config') || names.includes('commondir'))) {
        directories.add(path);
        if (directories.size > 256)
          throw new GitError('SUBMODULE_LIMIT', 'Too many stored submodule repositories to review');
        await visit(join(path, 'modules'), depth + 1);
        await visit(join(path, 'worktrees'), depth + 1);
      } else for (const name of names) await visit(join(path, name), depth + 1);
    };
    const moduleRoots = new Set([
      join(this.repo.gitDir, 'modules'),
      join(this.repo.commonDir, 'modules'),
      ...[...directories].map((path) => join(path, 'modules')),
    ]);
    for (const path of moduleRoots) await visit(path, 0);
    for (const gitDir of directories) {
      await this.operation(gitDir);
      const prefix = [`--git-dir=${gitDir}`, `--work-tree=${this.repo.path}`];
      const index = await this.run([...prefix, 'ls-files', '--stage', '-z'], {
        cwd: this.repo.path,
        signal,
        maxBytes: 16 * 1024 * 1024,
      });
      const flags = new NulDecoder((record) => {
        const flag = record[0];
        if (flag === 83 || (flag !== undefined && flag >= 97 && flag <= 122))
          throw new GitError(
            'SUBMODULE_INDEX_FLAGS',
            'Clear skip-worktree and assume-unchanged flags before updating submodules',
          );
      });
      await this.run([...prefix, 'ls-files', '-v', '-z'], {
        cwd: this.repo.path,
        signal,
        maxBytes: 16 * 1024 * 1024,
        onStdout: (chunk) => flags.push(chunk),
      });
      flags.finish();
      const staged = await this.run([...prefix, 'diff', '--cached', '--quiet', '--no-ext-diff'], {
        cwd: this.repo.path,
        signal,
        allowedExitCodes: [0, 1],
      });
      if (staged.exitCode)
        throw new GitError(
          'SUBMODULE_STAGED',
          'Commit or preserve staged changes in submodules before updating, including deinitialized checkouts',
        );
      const head = await text(
        this.repo.path,
        [...prefix, 'rev-parse', '--verify', '--quiet', 'HEAD'],
        [0, 1],
      );
      if (
        head &&
        !(await text(this.repo.path, [
          ...prefix,
          'for-each-ref',
          `--contains=${head}`,
          '--format=%(refname)',
          'refs/heads',
          'refs/tags',
          'refs/remotes',
        ]))
      )
        throw new GitError(
          'SUBMODULE_UNREFERENCED',
          `Create a branch or tag at ${head} before updating the submodule stored at ${gitDir}`,
        );
      revisions.push(hash(JSON.stringify([gitDir, head, hash(index.stdout)])));
    }
    for (const gitDir of new Set([this.repo.gitDir, ...directories])) {
      const config = await this.run(
        [`--git-dir=${gitDir}`, `--work-tree=${this.repo.path}`, 'config', '--null', '--list'],
        { cwd: this.repo.path, signal, maxBytes: 2 * 1024 * 1024 },
      );
      configs.set(gitDir, hash(config.stdout));
      for (const record of config.stdout.toString('utf8').split('\0').filter(Boolean)) {
        const split = record.indexOf('\n');
        const key = record.slice(0, split < 0 ? undefined : split);
        const value = split < 0 ? '' : record.slice(split + 1);
        if (/^http\..*\.sslverify$/i.test(key)) tls.add(key);
        if (/^(?:remote|submodule)\..*\.url$/i.test(key) || /^url\..*\.insteadof$/i.test(key)) {
          if (!key.startsWith('url.')) validateUrl(value);
          sources.push({
            repository: gitDir,
            setting: redactGitMessage(key),
            value: redactGitMessage(value),
          });
          if (sources.length > 2048)
            throw new GitError('SUBMODULE_LIMIT', 'Too many submodule source settings to review');
        }
      }
    }
    if ([...tls].join('').length > 65536 || tls.size > 256)
      throw new GitError('SUBMODULE_LIMIT', 'Too many URL-specific TLS settings to enforce');
    const index = await this.run(['ls-files', '--stage', '-z'], {
      cwd: this.repo.path,
      signal,
      maxBytes: 16 * 1024 * 1024,
    });
    return {
      state,
      sources,
      tls: [...tls],
      fingerprint: hash(
        JSON.stringify([state.revision, hash(index.stdout), [...configs], revisions]),
      ),
    };
  }
  async preview(signal?: AbortSignal): Promise<SubmoduleUpdatePreview> {
    const inspected = await this.inspect(signal);
    const token = randomUUID();
    for (const [id, plan] of this.plans) if (plan.expiresAt < Date.now()) this.plans.delete(id);
    if (this.plans.size >= 32) this.plans.delete(this.plans.keys().next().value!);
    this.plans.set(this.repo.id, {
      token,
      fingerprint: inspected.fingerprint,
      expiresAt: Date.now() + 600000,
    });
    return { token, entries: inspected.state.entries, sources: inspected.sources };
  }
  async update(
    token: string,
    allowLocal: boolean,
    signal?: AbortSignal,
    onProgress?: (text: string) => void,
    authentication?: NodeJS.ProcessEnv,
  ) {
    const plan = this.plans.get(this.repo.id);
    if (!plan || plan.token !== token || plan.expiresAt < Date.now())
      throw new GitError(
        'STALE_SUBMODULE_UPDATE',
        'Review submodule update again before continuing',
      );
    const inspected = await this.inspect(signal);
    if (inspected.fingerprint !== plan.fingerprint) {
      this.plans.delete(this.repo.id);
      throw new GitError(
        'STALE_SUBMODULE_UPDATE',
        'Submodules or Git configuration changed. Review the update again',
      );
    }
    this.plans.delete(this.repo.id);
    const progress = onProgress ? new GitProgressLines(onProgress) : undefined;
    try {
      await this.run(
        [
          ...inspected.tls.flatMap((key) => ['-c', `${key}=true`]),
          'submodule',
          'update',
          '--init',
          '--recursive',
          '--checkout',
          '--jobs=1',
          '--',
          ...inspected.state.entries
            .filter((entry) => entry.depth === 0)
            .map((entry) => `:(literal)${entry.path}`),
        ],
        {
          cwd: this.repo.path,
          signal,
          readOnly: false,
          timeoutMs: 180000,
          maxBytes: 8 * 1024 * 1024,
          env: {
            ...authentication,
            GIT_ALLOW_PROTOCOL: allowLocal ? 'file:https:http:ssh:git' : 'https:http:ssh:git',
            GIT_PROTOCOL_FROM_USER: '0',
          },
          onStderr: progress ? (chunk) => progress.push(chunk) : undefined,
        },
      );
    } catch (error) {
      if (error instanceof GitError) throw transportError(error);
      throw error;
    } finally {
      progress?.end();
    }
    return new Submodules(this.repo, this.run).list(signal);
  }
}
