import {
  changedFileSchema,
  commitFilesSchema,
  oidSchema,
  type ChangedFile,
} from '@openkraken/ipc-contract';
import { NulDecoder } from './parsers.js';
import { GitError, type RunOptions, type runGit } from './runner.js';
const statuses = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'typechange',
} as const;
/** Raw diff records keep paths outside the space-delimited metadata header. */
export class DiffTreeParser {
  private files: ChangedFile[] = [];
  private pending?: {
    oldMode: string;
    newMode: string;
    oldOid?: string;
    newOid?: string;
    status: ChangedFile['status'];
    similarity?: number;
    first?: Buffer;
  };
  private decoder = new NulDecoder((record) => {
    if (!this.pending) {
      const header =
        /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) ([AMDRCT])(\d{1,3})?$/.exec(
          record.toString('ascii'),
        );
      if (!header) throw new GitError('INVALID_DIFF', 'Git returned an invalid raw diff header');
      const status = statuses[header[5] as keyof typeof statuses];
      this.pending = {
        oldMode: header[1]!,
        newMode: header[2]!,
        oldOid: /^0+$/.test(header[3]!) ? undefined : header[3]!,
        newOid: /^0+$/.test(header[4]!) ? undefined : header[4]!,
        status,
        ...(header[6] ? { similarity: Number(header[6]) } : {}),
      };
      return;
    }
    if (!record.length) throw new GitError('INVALID_DIFF', 'Git returned an empty diff path');
    const entry = this.pending;
    if (['renamed', 'copied'].includes(entry.status) && !entry.first) {
      entry.first = record;
      return;
    }
    const oldPath = entry.status === 'added' ? undefined : (entry.first ?? record);
    const newPath = entry.status === 'deleted' ? undefined : record;
    this.files.push(
      changedFileSchema.parse({
        path: record.toString('utf8'),
        pathBytes: record.toString('base64'),
        ...(oldPath
          ? { oldPath: oldPath.toString('utf8'), oldPathBytes: oldPath.toString('base64') }
          : {}),
        ...(newPath
          ? { newPath: newPath.toString('utf8'), newPathBytes: newPath.toString('base64') }
          : {}),
        oldMode: entry.oldMode,
        newMode: entry.newMode,
        oldOid: entry.oldOid,
        newOid: entry.newOid,
        status: entry.status,
        similarity: entry.similarity,
      }),
    );
    if (this.files.length > 10000)
      throw new GitError('DIFF_LIMIT', 'The commit changes more than 10,000 files');
    this.pending = undefined;
  });
  push(chunk: Buffer) {
    this.decoder.push(chunk);
  }
  finish() {
    this.decoder.finish();
    if (this.pending) throw new GitError('INVALID_DIFF', 'Git returned a truncated raw diff');
    return this.files;
  }
}
export async function commitFiles(
  run: (args: string[], options?: RunOptions) => ReturnType<typeof runGit>,
  input: string,
  parentInput?: string,
  signal?: AbortSignal,
) {
  const oid = oidSchema.parse(input);
  const parent = parentInput === undefined ? undefined : oidSchema.parse(parentInput);
  const ancestry = (
    await run(['rev-list', '--no-walk', '--parents', '--max-count=1', oid, '--'], {
      signal,
      maxBytes: 131072,
    })
  ).stdout
    .toString()
    .trim()
    .split(' ');
  const commit = oidSchema.parse(ancestry[0]);
  const parents = ancestry.slice(1).map((value) => oidSchema.parse(value));
  if (parent && !parents.includes(parent))
    throw new GitError('INVALID_PARENT', 'Select one of this commit’s parents');
  const selected = parent ?? parents[0];
  const parser = new DiffTreeParser();
  await run(
    [
      'diff-tree',
      '--no-commit-id',
      '--raw',
      '-r',
      '-z',
      '--no-abbrev',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--ignore-submodules=none',
      '-M',
      '-l1000',
      ...(selected ? [selected, commit] : ['--root', commit]),
      '--',
    ],
    {
      signal,
      maxBytes: 16 * 1024 * 1024,
      timeoutMs: 30000,
      onStdout: (chunk) => parser.push(chunk),
    },
  );
  return commitFilesSchema.parse({ commit, parent: selected, parents, files: parser.finish() });
}
