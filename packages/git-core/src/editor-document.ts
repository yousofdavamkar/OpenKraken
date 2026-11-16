import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { Repository } from '@openkraken/ipc-contract';
import { GitError } from './runner.js';
const LIMIT = 1024 * 1024;
export type GitEditor = (
  document: { path: string; text: string },
  signal: AbortSignal,
) => Promise<string | { text: string; written: () => void } | null>;
async function reviewedFile(repo: Repository, input: string) {
  const root = await realpath(repo.gitDir);
  const path = resolve(repo.path, input);
  const within = relative(root, path);
  if (
    !within ||
    within === '..' ||
    within.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) ||
    isAbsolute(within) ||
    (await realpath(path)) !== path ||
    (await lstat(path)).isSymbolicLink()
  )
    throw new GitError(
      'INVALID_EDITOR_PATH',
      'The requested document must be a regular file inside this repository’s Git metadata',
    );
  const file = await open(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > LIMIT)
      throw new GitError(
        'EDITOR_LIMIT',
        'The Git editor supports regular text documents up to 1 MiB',
      );
    const buffer = Buffer.alloc(LIMIT + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > LIMIT || buffer.subarray(0, length).includes(0))
      throw new GitError(
        'EDITOR_LIMIT',
        'The Git editor requires text up to 1 MiB without NUL bytes',
      );
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      buffer.subarray(0, length),
    );
    return { file, path, text, info };
  } catch (error) {
    await file.close();
    throw error;
  }
}
export async function editGitDocument(
  repo: Repository,
  input: string,
  edit: GitEditor | undefined,
  signal: AbortSignal,
) {
  if (!edit)
    throw new GitError(
      'EDITOR_REQUIRED',
      'Git requested a document that needs review in the desktop editor',
    );
  const before = await reviewedFile(repo, input);
  await before.file.close();
  signal.throwIfAborted();
  const answer = await edit({ path: before.path, text: before.text }, signal);
  signal.throwIfAborted();
  if (answer === null) throw new GitError('CANCELLED', 'Git editor cancelled');
  const text = typeof answer === 'string' ? answer : answer.text;
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > LIMIT || bytes.includes(0) || bytes.toString('utf8') !== text)
    throw new GitError('EDITOR_LIMIT', 'Enter valid UTF-8 text of at most 1 MiB');
  const current = await reviewedFile(repo, input);
  try {
    if (
      current.info.dev !== before.info.dev ||
      current.info.ino !== before.info.ino ||
      current.text !== before.text
    )
      throw new GitError(
        'STALE_EDITOR',
        'The Git document changed while it was open. Newer contents were preserved',
      );
    signal.throwIfAborted();
    await current.file.truncate(0);
    let written = 0;
    while (written < bytes.length) {
      const { bytesWritten } = await current.file.write(
        bytes,
        written,
        bytes.length - written,
        written,
      );
      if (!bytesWritten)
        throw new GitError('EDITOR_WRITE', 'The editor could not finish saving the document');
      written += bytesWritten;
    }
    await current.file.sync();
  } finally {
    await current.file.close();
  }
  if (typeof answer !== 'string') answer.written();
}
