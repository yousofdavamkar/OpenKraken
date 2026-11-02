import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { InteractiveRebase, Repository } from '@openkraken/ipc-contract';
import { GitError } from './runner.js';
async function metadata(path: string) {
  if ((await lstat(path)).isSymbolicLink())
    throw new GitError('INVALID_EDITOR_PATH', 'Git editor metadata must not be a symbolic link');
  const file = await open(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
  const info = await file.stat();
  if (!info.isFile() || info.nlink !== 1 || info.size > 2 * 1024 * 1024) {
    await file.close();
    throw new GitError('EDITOR_LIMIT', 'Git editor metadata exceeds the supported size');
  }
  return file;
}
export async function editRebaseFile(
  repo: Repository,
  plan: InteractiveRebase,
  requested: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const gitDir = await realpath(repo.gitDir);
  const path = resolve(repo.path, requested);
  const todo = join(gitDir, 'rebase-merge', 'git-rebase-todo');
  const message = join(gitDir, 'COMMIT_EDITMSG');
  if (![todo, message].includes(path) || (await realpath(dirname(path))) !== dirname(path))
    throw new GitError('INVALID_EDITOR_PATH', 'Git requested an unapproved rebase editor path');
  let text: string | undefined;
  if (path === todo) text = plan.steps.map((step) => `${step.action} ${step.oid}\n`).join('');
  else {
    const directory = join(gitDir, 'rebase-merge');
    if ((await realpath(directory)) !== directory)
      throw new GitError('INVALID_EDITOR_PATH', 'Rebase metadata must not be redirected');
    const done = await metadata(join(directory, 'done'));
    let lines: string[];
    try {
      const buffer = Buffer.alloc(2 * 1024 * 1024 + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await done.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length === buffer.length)
        throw new GitError('EDITOR_LIMIT', 'Rebase progress exceeds the supported size');
      lines = new TextDecoder('utf-8', { fatal: true })
        .decode(buffer.subarray(0, length))
        .trim()
        .split('\n');
    } finally {
      await done.close();
    }
    const completed = lines
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const [action, oid] = line.split(/\s+/);
        const step = plan.steps.find((step) => step.oid === oid && step.action === action);
        if (!step)
          throw new GitError(
            'REBASE_PLAN_CHANGED',
            'The native rebase todo changed outside this reviewed plan',
          );
        return step;
      });
    const current = completed.at(-1);
    if (!current)
      throw new GitError('REBASE_PLAN_CHANGED', 'The native rebase has no reviewed current step');
    text = current.newMessage;
    // A final fixup can trigger the editor for an earlier squash in the same chain.
    if (current.action === 'fixup') {
      for (const step of completed.toReversed()) {
        if (step.action === 'squash') {
          text = step.newMessage;
          break;
        }
        if (step.action !== 'fixup' && step.action !== 'drop') break;
      }
    }
  }
  const file = await metadata(path);
  try {
    signal.throwIfAborted();
    if (text !== undefined) {
      await file.truncate(0);
      await file.writeFile(text.endsWith('\n') ? text : text + '\n', 'utf8');
      await file.sync();
    }
  } finally {
    await file.close();
  }
}
