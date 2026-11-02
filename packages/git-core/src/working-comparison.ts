import {
  workingComparisonOptionsSchema,
  type WorkingComparisonOptions,
  type StatusEntry,
  type ChangedFile,
  type FileVersion,
} from '@openkraken/ipc-contract';
import { FileBackups } from './file-backups.js';
import { compareVersions, contentVersion, readBlobVersion } from './file-comparison.js';
import { gitArgumentPath } from './file-history.js';
import { parsePatch } from './patch.js';
import { GitError, type RunOptions, type runGit } from './runner.js';
type Run = (args: string[], options?: RunOptions) => ReturnType<typeof runGit>;
/** Apply a complete native patch to its exact base, retaining arbitrary bytes and EOF state. */
export function patchedContents(base: Buffer, patch: Buffer, path: string): Buffer {
  const old = base.toString('latin1').match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const hunks = parsePatch(patch.toString('latin1'), path).hunks;
  const output: string[] = [];
  let cursor = 0;
  for (const hunk of hunks) {
    const start = hunk.oldLines ? hunk.oldStart - 1 : hunk.oldStart;
    if (start < cursor || start > old.length)
      throw new GitError('INVALID_DIFF', 'Native diff does not match its base');
    for (; cursor < start; cursor++) output.push(old[cursor]!);
    let consumed = 0,
      produced = 0;
    for (const line of hunk.lines) {
      const text = line.text + (line.noNewline ? '' : '\n');
      if (line.kind !== 'add' && old[cursor++] !== text)
        throw new GitError('INVALID_DIFF', 'Native diff context changed while reading');
      if (line.kind !== 'add') consumed++;
      if (line.kind !== 'del') {
        produced++;
        output.push(text);
      }
    }
    if (consumed !== hunk.oldLines || produced !== hunk.newLines)
      throw new GitError('INVALID_DIFF', 'Native diff line counts do not match the patch');
  }
  for (; cursor < old.length; cursor++) output.push(old[cursor]!);
  return Buffer.from(output.join(''), 'latin1');
}
async function objectAt(run: Run, args: string[], index: boolean, signal?: AbortSignal) {
  const output = (await run(args, { signal, maxBytes: 128 * 1024 })).stdout;
  if (!output.length) return { mode: '000000', oid: undefined };
  const match = (
    index
      ? /^([0-7]{6}) ([0-9a-f]{40}|[0-9a-f]{64}) 0\t/
      : /^([0-7]{6}) (?:blob|commit) ([0-9a-f]{40}|[0-9a-f]{64})\t/
  ).exec(output.toString('utf8'));
  if (!match) throw new GitError('COMPARISON_UNSUPPORTED', 'Select a resolved file or submodule');
  return { mode: match[1]!, oid: match[2]! };
}
export async function workingComparison(
  run: Run,
  backups: FileBackups,
  input: WorkingComparisonOptions,
  entry: StatusEntry,
  head: string | undefined,
  signal?: AbortSignal,
) {
  const options = workingComparisonOptionsSchema.parse(input);
  const path = gitArgumentPath(options.pathBytes);
  if (entry.kind === 'conflict')
    throw new GitError('COMPARISON_UNSUPPORTED', 'Use the conflict editor for unresolved files');
  const index = await objectAt(run, ['ls-files', '--stage', '-z', '--', path], true, signal);
  const beforePath =
    options.side === 'index' && entry.origPathBytes ? gitArgumentPath(entry.origPathBytes) : path;
  const before =
    options.side === 'index'
      ? head
        ? await objectAt(run, ['ls-tree', '-z', head, '--', beforePath], false, signal)
        : { mode: '000000', oid: undefined }
      : entry.kind === 'untracked'
        ? { mode: '000000', oid: undefined }
        : index;
  const oldVersion = await readBlobVersion(
    run,
    before.oid,
    before.mode,
    !!options.allowLarge,
    options.encoding,
    signal,
  );
  let newVersion: FileVersion;
  if (options.side === 'index')
    newVersion = await readBlobVersion(
      run,
      index.oid,
      index.mode,
      !!options.allowLarge,
      options.encoding,
      signal,
    );
  else {
    if (index.mode === '160000')
      throw new GitError(
        'COMPARISON_UNSUPPORTED',
        'Use submodule controls for a submodule working tree',
      );
    const { image, bytes } = await backups.read(
      options.pathBytes,
      options.allowLarge ? 20 * 1024 * 1024 : 2 * 1024 * 1024,
      signal,
    );
    const mode =
      image.kind === 'missing'
        ? '000000'
        : image.kind === 'symlink'
          ? '120000'
          : image.mode! & 0o111
            ? '100755'
            : '100644';
    if (image.kind !== 'missing' && !bytes)
      newVersion = { kind: 'large', mode, bytes: image.bytes! };
    else if (oldVersion.kind === 'large')
      newVersion =
        image.kind === 'missing'
          ? { kind: 'missing', mode, bytes: 0 }
          : contentVersion(bytes!, undefined, mode, !!options.allowLarge, options.encoding);
    else {
      const patch = (
        await run(
          [
            '-c',
            'diff.suppressBlankEmpty=false',
            'diff',
            '--no-ext-diff',
            '--no-textconv',
            '--no-renames',
            '--no-color',
            '--text',
            '--unified=3',
            '--output-indicator-new=+',
            '--output-indicator-old=-',
            '--output-indicator-context= ',
            '--',
            path,
          ],
          { signal, maxBytes: 64 * 1024 * 1024 },
        )
      ).stdout;
      const base = before.oid
        ? (await run(['cat-file', 'blob', before.oid], { signal, maxBytes: 20 * 1024 * 1024 }))
            .stdout
        : Buffer.alloc(0);
      const content = patchedContents(base, patch, path);
      const parsed = parsePatch(patch.toString('latin1'), path);
      const nativeMode = patch.length
        ? parsed.newMode
        : before.mode === '000000'
          ? mode
          : before.mode;
      newVersion =
        image.kind === 'missing'
          ? { kind: 'missing', mode, bytes: 0 }
          : contentVersion(content, undefined, nativeMode, !!options.allowLarge, options.encoding);
    }
    await backups.assertCurrent([image], 'FILE_CHANGED');
  }
  const oldExists = oldVersion.kind !== 'missing',
    newExists = newVersion.kind !== 'missing';
  const file: ChangedFile = {
    path,
    pathBytes: options.pathBytes,
    oldPath: oldExists ? beforePath : undefined,
    oldPathBytes: oldExists ? Buffer.from(beforePath).toString('base64') : undefined,
    newPath: newExists ? path : undefined,
    newPathBytes: newExists ? options.pathBytes : undefined,
    oldMode: oldVersion.mode,
    newMode: newVersion.mode,
    oldOid: oldVersion.oid,
    newOid: newVersion.oid,
    status: !oldExists
      ? 'added'
      : !newExists
        ? 'deleted'
        : beforePath !== path
          ? 'renamed'
          : oldVersion.mode.slice(0, 3) !== newVersion.mode.slice(0, 3)
            ? 'typechange'
            : 'modified',
  };
  return compareVersions(run, file, oldVersion, newVersion, options, signal);
}
