import { constants } from 'node:fs';
import { open, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { oidSchema, type OperationState } from '@openkraken/ipc-contract';
import { GitError } from './runner.js';
/** Native operation metadata is data; no todo command or path is executed here. */
export async function inspectOperation(gitDir: string) {
  const files = new Map<string, string>();
  const identities = new Map<string, string>();
  const identityOf = (info: { dev: number; ino: number; birthtimeMs: number }) =>
    `${info.dev}:${info.ino}:${info.birthtimeMs}`;
  const directories = new Set<string>();
  for (const name of ['rebase-merge', 'rebase-apply', 'sequencer']) {
    try {
      const info = await lstat(join(gitDir, name));
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new GitError(
          'OPERATION_STATE_INVALID',
          'Git operation metadata must be a real directory',
        );
      directories.add(name);
      identities.set(name, identityOf(info));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const names = [
    'MERGE_HEAD',
    'MERGE_MSG',
    'ORIG_HEAD',
    'CHERRY_PICK_HEAD',
    'REVERT_HEAD',
    'BISECT_LOG',
  ];
  const nested = {
    'rebase-merge': [
      'head-name',
      'orig-head',
      'stopped-sha',
      'msgnum',
      'end',
      'message',
      'git-rebase-todo',
      'done',
      'interactive',
      'amend',
    ],
    'rebase-apply': [
      'applying',
      'head-name',
      'orig-head',
      'original-commit',
      'next',
      'last',
      'final-commit',
    ],
    sequencer: ['head', 'todo', 'abort-safety', 'opts'],
  };
  for (const [directory, entries] of Object.entries(nested))
    if (directories.has(directory)) names.push(...entries.map((entry) => `${directory}/${entry}`));
  const fingerprint = createHash('sha256').update(JSON.stringify([...directories]));
  for (const name of names) {
    try {
      const path = join(gitDir, name);
      if ((await lstat(path)).isSymbolicLink())
        throw new GitError(
          'OPERATION_STATE_INVALID',
          'Git operation metadata must not be a symbolic link',
        );
      const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const limit = /(?:todo|done)$/.test(name) ? 1048576 : 65536;
        const info = await file.stat();
        identities.set(name, identityOf(info));
        if (!info.isFile() || info.size > limit)
          throw new GitError(
            'OPERATION_STATE_LIMIT',
            'Git operation metadata exceeds the supported size',
          );
        const buffer = Buffer.alloc(limit + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
          if (!bytesRead) break;
          length += bytesRead;
        }
        const bytes = buffer.subarray(0, length);
        if (length > limit)
          throw new GitError(
            'OPERATION_STATE_LIMIT',
            'Git operation metadata exceeds the supported size',
          );
        fingerprint
          .update(name + '\0')
          .update(bytes)
          .update('\0');
        files.set(name, bytes.toString('utf8'));
      } finally {
        await file.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  let kind: OperationState['kind'] = 'none';
  if (directories.has('rebase-merge')) kind = 'rebase';
  else if (directories.has('rebase-apply'))
    kind = files.has('rebase-apply/applying') ? 'am' : 'rebase';
  else if (files.has('MERGE_HEAD')) kind = 'merge';
  else if (files.has('CHERRY_PICK_HEAD')) kind = 'cherry-pick';
  else if (files.has('REVERT_HEAD')) kind = 'revert';
  else if (directories.has('sequencer'))
    kind = files.get('sequencer/todo')?.trimStart().startsWith('revert ')
      ? 'revert'
      : 'cherry-pick';
  else if (files.has('BISECT_LOG')) kind = 'bisect';
  const oid = (...names: string[]) => {
    for (const name of names) {
      const parsed = oidSchema.safeParse(files.get(name)?.trim());
      if (parsed.success) return parsed.data;
    }
    return undefined;
  };
  const backend = directories.has('rebase-merge') ? 'rebase-merge' : 'rebase-apply';
  const current = Number(files.get(`${backend}/${backend === 'rebase-merge' ? 'msgnum' : 'next'}`));
  const total = Number(files.get(`${backend}/${backend === 'rebase-merge' ? 'end' : 'last'}`));
  const branch = files.get(`${backend}/head-name`)?.trim();
  const details: Omit<OperationState, 'token' | 'conflicts'> = {
    kind,
    actions:
      kind === 'merge'
        ? ['continue', 'abort']
        : ['rebase', 'cherry-pick', 'revert'].includes(kind)
          ? ['continue', 'skip', 'abort']
          : [],
    message:
      kind === 'none'
        ? ''
        : (files.get(`${backend}/message`) ??
          files.get(`${backend}/final-commit`) ??
          files.get('MERGE_MSG') ??
          ''),
    ...(kind !== 'none'
      ? {
          originalHead:
            kind === 'merge' ? oid('ORIG_HEAD') : oid(`${backend}/orig-head`, 'sequencer/head'),
        }
      : {}),
    ...(['cherry-pick', 'revert'].includes(kind)
      ? { currentCommit: oid(kind === 'cherry-pick' ? 'CHERRY_PICK_HEAD' : 'REVERT_HEAD') }
      : {}),
    ...(kind === 'rebase'
      ? {
          currentCommit: oid(`${backend}/stopped-sha`, `${backend}/original-commit`),
          ...(oid('rebase-merge/amend') ? { editStopped: true } : {}),
          ...(branch?.startsWith('refs/heads/') ? { branchRef: branch } : {}),
          ...(Number.isSafeInteger(current) &&
          Number.isSafeInteger(total) &&
          current >= 0 &&
          total > 0 &&
          total <= 1000000
            ? { progress: { current: Math.min(current, total), total } }
            : {}),
        }
      : {}),
  };
  const anchor =
    kind === 'rebase' || kind === 'am'
      ? backend
      : kind === 'merge'
        ? 'MERGE_HEAD'
        : directories.has('sequencer')
          ? 'sequencer'
          : kind === 'cherry-pick'
            ? 'CHERRY_PICK_HEAD'
            : kind === 'revert'
              ? 'REVERT_HEAD'
              : undefined;
  // Stable through resolution/continuation, but different for a newly created native operation.
  const identity = anchor
    ? createHash('sha256')
        .update(
          JSON.stringify([
            kind,
            anchor,
            identities.get(anchor),
            files.get(anchor),
            details.originalHead,
            details.branchRef,
          ]),
        )
        .digest('hex')
    : undefined;
  return { details, fingerprint: fingerprint.digest('hex'), identity };
}
