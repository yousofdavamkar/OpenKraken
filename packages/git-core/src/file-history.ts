import {
  fileHistoryEntrySchema,
  fileHistoryOptionsSchema,
  type FileHistoryEntry,
  type FileHistoryOptions,
} from '@openkraken/ipc-contract';
import { NulDecoder } from './parsers.js';
import { GitError, type RunOptions, type runGit } from './runner.js';
type Run = (args: string[], options?: RunOptions) => ReturnType<typeof runGit>;
export function gitArgumentPath(encoded: string) {
  const raw = Buffer.from(encoded, 'base64');
  let path: string;
  try {
    path = new TextDecoder('utf8', { fatal: true, ignoreBOM: true }).decode(raw);
  } catch {
    throw new GitError('UNSUPPORTED_PATH', 'This Git command requires a UTF-8 filename');
  }
  if (
    !path ||
    path.startsWith('/') ||
    path.includes('\0') ||
    path.split('/').some((part) => part === '..' || part === '.')
  )
    throw new GitError('INVALID_PATH', 'Select a repository-relative filename');
  return path;
}
export class FileHistoryParser {
  constructor(private skip = 0) {}
  private entries: FileHistoryEntry[] = [];
  private fields: string[] = [];
  private remainingPaths = 0;
  private status = '';
  private decoder = new NulDecoder((record) => {
    if (this.fields.length < 4) {
      this.fields.push(record.toString('utf8'));
      return;
    }
    if (!this.remainingPaths) {
      const status = /^\n?([AMDRCT])(\d{1,3})?$/.exec(record.toString('ascii'));
      if (!status)
        throw new GitError('INVALID_HISTORY', 'Git returned an invalid file-history status');
      this.status = status[1]!;
      this.remainingPaths = ['R', 'C'].includes(this.status) ? 2 : 1;
      return;
    }
    if (!record.length)
      throw new GitError('INVALID_HISTORY', 'Git returned an empty file-history path');
    if (--this.remainingPaths) return;
    const entry = fileHistoryEntrySchema.parse({
      oid: this.fields[0],
      author: this.fields[1],
      time: Number(this.fields[2]),
      summary: this.fields[3],
      path: record.toString('utf8'),
      pathBytes: record.toString('base64'),
      status: this.status,
    });
    if (this.skip > 0) this.skip--;
    else this.entries.push(entry);
    if (this.entries.length > 201)
      throw new GitError('HISTORY_LIMIT', 'Too many file-history entries');
    this.fields = [];
  });
  push(chunk: Buffer) {
    this.decoder.push(chunk);
  }
  finish() {
    this.decoder.finish();
    if (this.fields.length || this.remainingPaths)
      throw new GitError('INVALID_HISTORY', 'Git returned truncated file history');
    return this.entries;
  }
}
export async function fileHistory(run: Run, input: FileHistoryOptions, signal?: AbortSignal) {
  const options = fileHistoryOptionsSchema.parse(input);
  const path = gitArgumentPath(options.pathBytes);
  const offset = options.offset ?? 0,
    limit = options.limit ?? 50;
  // --skip prevents Git from processing renames in skipped commits. Replay the
  // bounded prefix instead, dropping entries only after native rename traversal.
  const parser = new FileHistoryParser(offset);
  await run(
    [
      '--literal-pathspecs',
      '-c',
      'log.showSignature=false',
      'log',
      '--follow',
      '--root',
      '--diff-merges=off',
      '--find-renames',
      '--no-ext-diff',
      '--no-textconv',
      '--no-color',
      '--no-decorate',
      '--no-notes',
      '--format=%H%x00%an%x00%at%x00%s',
      '--name-status',
      '-z',
      `--max-count=${offset + limit + 1}`,
      options.commit,
      '--',
      path,
    ],
    { signal, maxBytes: 32 * 1024 * 1024, onStdout: (chunk) => parser.push(chunk) },
  );
  const entries = parser.finish();
  return {
    entries: entries.slice(0, limit),
    nextOffset: entries.length > limit ? offset + limit : undefined,
  };
}
