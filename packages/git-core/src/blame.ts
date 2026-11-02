import { StringDecoder } from 'node:string_decoder';
import {
  blameOptionsSchema,
  blameLineSchema,
  type BlameOptions,
  type BlameLine,
} from '@openkraken/ipc-contract';
import { gitArgumentPath } from './file-history.js';
import { decodeText } from './text-encoding.js';
import { GitError, type RunOptions, type runGit } from './runner.js';
type Run = (args: string[], options?: RunOptions) => ReturnType<typeof runGit>;
export class BlameParser {
  private decoder = new StringDecoder('utf8');
  private pending = '';
  private row?: Partial<BlameLine>;
  private batch: BlameLine[] = [];
  private count = 0;
  constructor(private accept: (lines: BlameLine[]) => void) {}
  push(chunk: Buffer) {
    this.pending += this.decoder.write(chunk);
    let start = 0,
      end: number;
    while ((end = this.pending.indexOf('\n', start)) !== -1) {
      this.line(this.pending.slice(start, end));
      start = end + 1;
    }
    this.pending = this.pending.slice(start);
    if (this.pending.length > 2 * 1024 * 1024)
      throw new GitError('BLAME_LIMIT', 'Blame record exceeds the display limit');
  }
  private line(value: string) {
    if (!this.row) {
      const header = /^([0-9a-f]{40}|[0-9a-f]{64}) (\d+) (\d+)(?: (\d+))?$/.exec(value);
      if (!header) throw new GitError('INVALID_BLAME', 'Git returned an invalid blame header');
      this.row = { oid: header[1], originalLine: Number(header[2]), line: Number(header[3]) };
      return;
    }
    if (value.startsWith('\t')) {
      const row = blameLineSchema.parse({ ...this.row, text: value.slice(1) });
      if (row.line !== ++this.count || this.count > 50000)
        throw new GitError('BLAME_LIMIT', 'Blame line order or count exceeds the display limit');
      this.batch.push(row);
      this.row = undefined;
      if (this.batch.length === 64) this.flush();
    } else if (value.startsWith('author ')) this.row.author = value.slice(7);
    else if (value.startsWith('author-mail '))
      this.row.email = value.slice(12).replace(/^<|>$/g, '');
    else if (value.startsWith('author-time ')) this.row.time = Number(value.slice(12));
    else if (value.startsWith('summary ')) this.row.summary = value.slice(8);
  }
  private flush() {
    if (this.batch.length) {
      const batch = this.batch;
      this.batch = [];
      this.accept(batch);
    }
  }
  finish() {
    this.pending += this.decoder.end();
    if (this.pending || this.row)
      throw new GitError('INVALID_BLAME', 'Git returned truncated blame');
    this.flush();
    return { lines: this.count };
  }
}
export async function blame(
  run: Run,
  input: BlameOptions,
  signal: AbortSignal | undefined,
  accept: (lines: BlameLine[]) => void,
) {
  const options = blameOptionsSchema.parse(input),
    path = gitArgumentPath(options.pathBytes);
  const entry = (
    await run(['--literal-pathspecs', 'ls-tree', '-z', options.commit, '--', path], {
      signal,
      maxBytes: 128 * 1024,
    })
  ).stdout;
  const metadata = /^([0-7]{6}) blob ([0-9a-f]{40}|[0-9a-f]{64})\t/.exec(entry.toString('utf8'));
  if (!metadata || !/^100(?:644|755)$/.test(metadata[1]!))
    throw new GitError('BLAME_UNSUPPORTED', 'Blame requires a regular text file at this commit');
  const oid = metadata[2]!;
  const size = Number(
    (await run(['cat-file', '-s', oid], { signal, maxBytes: 128 })).stdout.toString(),
  );
  if (!Number.isSafeInteger(size) || size > 2 * 1024 * 1024)
    throw new GitError('BLAME_LIMIT', 'Blame supports text files up to 2 MiB');
  const bytes = (await run(['cat-file', 'blob', oid], { signal, maxBytes: 2 * 1024 * 1024 }))
    .stdout;
  const text = decodeText(bytes, 'UTF-8');
  if (!text) throw new GitError('BLAME_UNSUPPORTED', 'Blame currently supports UTF-8 text files');
  let lines = bytes.length && bytes.at(-1) !== 10 ? 1 : 0;
  for (const byte of bytes) if (byte === 10) lines++;
  if (lines > 50000) throw new GitError('BLAME_LIMIT', 'Blame supports up to 50,000 lines');
  if (!lines) return { lines: 0 };
  const parser = new BlameParser(accept);
  await run(
    [
      '-c',
      'blame.showEmail=false',
      '-c',
      'blame.showRoot=true',
      'blame',
      '--line-porcelain',
      '--encoding=UTF-8',
      '--no-textconv',
      options.commit,
      '--',
      path,
    ],
    { signal, maxBytes: 64 * 1024 * 1024, onStdout: (chunk) => parser.push(chunk) },
  );
  const result = parser.finish();
  if (result.lines !== lines)
    throw new GitError('INVALID_BLAME', 'Blame did not cover the selected file');
  return result;
}
