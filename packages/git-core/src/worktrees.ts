import { createHash } from 'node:crypto';
import { readdir, realpath } from 'node:fs/promises';
import {
  worktreeAddSchema,
  worktreeActionSchema,
  type WorktreeAction,
  type WorktreeAdd,
  type Repository,
  type Worktree,
  type WorktreeState,
} from '@openkraken/ipc-contract';
import { GitError, type RunOptions } from './runner.js';
import { NulDecoder, StatusParser } from './parsers.js';

type Run = (args: string[], options: RunOptions) => Promise<{ stdout: Buffer }>;
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

export class Worktrees {
  constructor(
    private repo: Repository,
    private run: Run,
  ) {}

  async list(signal?: AbortSignal): Promise<WorktreeState> {
    const { stdout } = await this.run(['worktree', 'list', '--porcelain', '-z'], {
      cwd: this.repo.path,
      signal,
      maxBytes: 4 * 1024 * 1024,
    });
    const entries: Worktree[] = [];
    let entry: Worktree | undefined;
    for (const field of stdout.toString('utf8').split('\0')) {
      if (!field) {
        entry = undefined;
        continue;
      }
      if (field.startsWith('worktree ')) {
        if (entries.length === 256)
          throw new GitError('WORKTREE_LIMIT', 'Too many worktrees to display (maximum 256)');
        const path = field.slice(9);
        entry = {
          id: hash(path),
          path,
          main: entries.length === 0,
          current: path === this.repo.path,
          bare: false,
          detached: false,
          locked: false,
          prunable: false,
          available: false,
          changedFiles: null,
        };
        entries.push(entry);
      } else if (entry) {
        if (field.startsWith('HEAD ') && !/^0+$/.test(field.slice(5))) entry.head = field.slice(5);
        if (field.startsWith('branch ')) entry.branch = field.slice(7);
        if (field === 'bare') entry.bare = true;
        if (field === 'detached') entry.detached = true;
        if (field === 'locked' || field.startsWith('locked ')) {
          entry.locked = true;
          entry.lockReason = field.slice(7);
        }
        if (field === 'prunable' || field.startsWith('prunable ')) {
          entry.prunable = true;
          entry.pruneReason = field.slice(9);
        }
      }
    }
    // Do not turn undecodable filenames into paths for a different checkout.
    if (!Buffer.from(stdout.toString('utf8')).equals(stdout))
      throw new GitError(
        'WORKTREE_ENCODING',
        'Worktree paths must use UTF-8 to display and open them',
      );
    await Promise.all(
      entries.map(async (item) => {
        try {
          item.current = (await realpath(item.path)) === this.repo.path;
          const common = (
            await this.run(['rev-parse', '--path-format=absolute', '--git-common-dir'], {
              cwd: item.path,
              signal,
              maxBytes: 65536,
            })
          ).stdout
            .toString('utf8')
            .replace(/\n$/, '');
          if ((await realpath(common)) !== this.repo.commonDir)
            throw new GitError('WORKTREE_REPLACED', 'This folder belongs to another repository');
          item.available = true;
          if (!item.bare) {
            const parser = new StatusParser();
            await this.run(['status', '--porcelain=v2', '-z', '--untracked-files=all'], {
              cwd: item.path,
              signal,
              maxBytes: 8 * 1024 * 1024,
              onStdout: (chunk) => parser.push(chunk),
            });
            item.changedFiles = parser.finish().entries.length;
          }
        } catch (error) {
          if (signal?.aborted) throw error;
          item.available = false;
          item.problem = 'Worktree is unavailable or its status could not be read';
        }
      }),
    );
    return { revision: hash(stdout), entries };
  }

  private async review(id: string, revision: string, signal?: AbortSignal) {
    const state = await this.list(signal);
    if (state.revision !== revision)
      throw new GitError('STALE_WORKTREES', 'Worktrees changed. Refresh the list and try again.');
    const entry = state.entries.find((item) => item.id === id);
    if (!entry)
      throw new GitError(
        'WORKTREE_NOT_FOUND',
        'This worktree is not registered in this repository',
      );
    return entry;
  }

  async select(id: string, revision: string, signal?: AbortSignal) {
    const entry = await this.review(id, revision, signal);
    if (!entry.available)
      throw new GitError('WORKTREE_UNAVAILABLE', 'This worktree is unavailable');
    return entry;
  }

  async action(input: WorktreeAction, signal?: AbortSignal) {
    const options = worktreeActionSchema.parse(input);
    const entry = await this.review(options.worktreeId, options.revision, signal);
    if (entry.main)
      throw new GitError('MAIN_WORKTREE', 'The main worktree cannot be locked or removed');
    if (options.action === 'remove') {
      if (entry.current)
        throw new GitError('CURRENT_WORKTREE', 'Open another worktree before removing this one');
      if (entry.locked)
        throw new GitError('WORKTREE_LOCKED', 'Unlock this worktree before removing it');
      if (!entry.available)
        throw new GitError('WORKTREE_UNAVAILABLE', 'This worktree is unavailable');
      const gitDir = (
        await this.run(['rev-parse', '--absolute-git-dir'], {
          cwd: entry.path,
          signal,
          maxBytes: 65536,
        })
      ).stdout
        .toString('utf8')
        .replace(/\n$/, '');
      const metadata = await readdir(gitDir);
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
        ].some((name) => metadata.includes(name))
      )
        throw new GitError(
          'WORKTREE_OPERATION',
          'Finish or abort the Git operation in this worktree before removing it.',
        );
      const flags = new NulDecoder((field) => {
        const flag = field.subarray(0, 1).toString();
        if (flag === 'S' || /[a-z]/.test(flag))
          throw new GitError(
            'WORKTREE_INDEX_FLAGS',
            'Clear skip-worktree and assume-unchanged flags, then review the files before removing this worktree.',
          );
      });
      await this.run(['ls-files', '-v', '-z'], {
        cwd: entry.path,
        signal,
        maxBytes: 8 * 1024 * 1024,
        onStdout: (chunk) => flags.push(chunk),
      });
      flags.finish();
      const parser = new StatusParser();
      await this.run(
        ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignored=matching'],
        {
          cwd: entry.path,
          signal,
          maxBytes: 8 * 1024 * 1024,
          onStdout: (chunk) => parser.push(chunk),
        },
      );
      if (parser.finish().entries.length)
        throw new GitError(
          'WORKTREE_NOT_CLEAN',
          'This worktree has changed, untracked or ignored files. Preserve them before removing it.',
        );
      if (entry.detached && entry.head) {
        const retained = await this.run(
          [
            'for-each-ref',
            `--contains=${entry.head}`,
            '--format=%(refname)',
            'refs/heads',
            'refs/tags',
            'refs/remotes',
          ],
          {
            cwd: this.repo.path,
            signal,
            maxBytes: 1024 * 1024,
          },
        );
        if (!retained.stdout.length)
          throw new GitError(
            'WORKTREE_UNREFERENCED',
            'Create a branch or tag to retain this detached worktree’s commits before removing it.',
          );
      }
    }
    const args =
      options.action === 'lock'
        ? ['lock', '--reason', options.reason, '--', entry.path]
        : [options.action, '--', entry.path];
    await this.run(['worktree', ...args], { cwd: this.repo.path, signal, readOnly: false });
    return this.list(signal);
  }

  async add(path: string, input: WorktreeAdd, signal?: AbortSignal) {
    const options = worktreeAddSchema.parse(input);
    const state = await this.list(signal);
    if (state.revision !== options.revision)
      throw new GitError('STALE_WORKTREES', 'Worktrees changed. Refresh the list and try again.');
    const destination = await realpath(path);
    if ((await readdir(destination)).length)
      throw new GitError(
        'WORKTREE_DESTINATION_NOT_EMPTY',
        'Choose an empty folder for the new worktree',
      );
    const settings = { cwd: this.repo.path, signal };
    await this.run(['rev-parse', '--verify', `${options.oid}^{commit}`], settings);
    if (options.mode !== 'detached') {
      await this.run(['check-ref-format', `refs/heads/${options.branch}`], settings);
      if (options.mode === 'existing') {
        const actual = (
          await this.run(['rev-parse', '--verify', `refs/heads/${options.branch}`], settings)
        ).stdout
          .toString('utf8')
          .trim();
        if (actual !== options.oid)
          throw new GitError(
            'STALE_WORKTREE_BRANCH',
            'The selected branch moved. Refresh before creating the worktree.',
          );
      }
    }
    const args =
      options.mode === 'new'
        ? ['-b', options.branch, '--', destination, options.oid]
        : options.mode === 'existing'
          ? ['--no-guess-remote', '--', destination, options.branch]
          : ['--detach', '--', destination, options.oid];
    await this.run(['worktree', 'add', ...args], { ...settings, readOnly: false });
    return this.list(signal);
  }
}
