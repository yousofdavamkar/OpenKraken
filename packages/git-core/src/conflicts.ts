import { createHash } from 'node:crypto';
import { conflictVersionSchema, type ConflictPreview } from '@openkraken/ipc-contract';
import { FileBackups } from './file-backups.js';
import { NulDecoder } from './parsers.js';
import { GitError, type RunOptions, type runGit } from './runner.js';
const TEXT_LIMIT = 2 * 1024 * 1024;
function text(bytes?: Buffer) {
  if (!bytes || bytes.includes(0)) return undefined;
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}
export class Conflicts {
  constructor(
    private run: (args: string[], options: RunOptions) => ReturnType<typeof runGit>,
    private backups: FileBackups,
  ) {}
  async inspect(
    pathBytes: string,
    revision: string,
    operation: ConflictPreview['operation'],
    signal?: AbortSignal,
    indexFile?: string,
  ) {
    const path = Buffer.from(pathBytes, 'base64');
    if (
      path.toString('base64') !== pathBytes ||
      path.includes(0) ||
      path
        .toString('latin1')
        .split('/')
        .some((part) => !part || ['.', '..', '.git'].includes(part.toLowerCase())) ||
      (process.platform === 'win32' && /[\\:]/.test(path.toString('latin1')))
    )
      throw new GitError('UNSAFE_PATH', 'Invalid conflict path');
    const stages = new Map<number, { mode: string; oid: string }>();
    const parser = new NulDecoder((record) => {
      const tab = record.indexOf(9);
      if (tab < 0) throw new GitError('INVALID_INDEX', 'Invalid unmerged index entry');
      if (!record.subarray(tab + 1).equals(path)) return;
      const [mode, oid, stage] = record.subarray(0, tab).toString().split(' ');
      stages.set(Number(stage), { mode: mode!, oid: oid! });
    });
    await this.run(['ls-files', '--unmerged', '-z'], {
      signal,
      indexFile,
      onStdout: (chunk) => parser.push(chunk),
    });
    parser.finish();
    if (!stages.size)
      throw new GitError('NO_CONFLICT', 'This file no longer has unresolved index stages');
    const version = async (stage: number) => {
      const entry = stages.get(stage);
      if (!entry) return undefined;
      if (entry.mode === '160000')
        return conflictVersionSchema.parse({ ...entry, bytes: 0, binary: true });
      const size = Number(
        (await this.run(['cat-file', '-s', entry.oid], { signal })).stdout.toString().trim(),
      );
      if (!Number.isSafeInteger(size) || size < 0)
        throw new GitError('INVALID_OBJECT', 'Invalid conflict blob size');
      const bytes =
        size <= TEXT_LIMIT
          ? (await this.run(['cat-file', 'blob', entry.oid], { signal, maxBytes: TEXT_LIMIT }))
              .stdout
          : undefined;
      const content = text(bytes);
      return conflictVersionSchema.parse({
        ...entry,
        bytes: size,
        text: content,
        binary: content === undefined,
      });
    };
    const [base, ours, theirs] = await Promise.all([version(1), version(2), version(3)]);
    const submodule = [...stages.values()].some((stage) => stage.mode === '160000');
    const work = submodule ? undefined : await this.backups.read(pathBytes, TEXT_LIMIT, signal);
    const editable =
      !submodule &&
      [base, ours, theirs].every(
        (stage) => !stage || (stage.mode.startsWith('100') && stage.text !== undefined),
      ) &&
      work?.image.kind !== 'symlink' &&
      (work?.image.kind === 'missing' || text(work?.bytes) !== undefined);
    const preview: ConflictPreview = {
      path: path.toString('utf8'),
      pathBytes,
      base,
      ours,
      theirs,
      operation,
      editable,
      working: {
        kind: submodule ? 'submodule' : work!.image.kind,
        bytes: work?.image.bytes ?? work?.bytes?.length ?? 0,
        text: text(work?.bytes),
      },
      token: createHash('sha256')
        .update(
          JSON.stringify({
            pathBytes,
            revision,
            operation,
            stages: [...stages],
            image: work?.image,
          }),
        )
        .digest('hex'),
    };
    return { preview, image: work?.image };
  }
}
