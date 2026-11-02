import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  commitComparisonOptionsSchema,
  fileComparisonSchema,
  type CommitComparisonOptions,
  type FileVersion,
} from '@openkraken/ipc-contract';
import { rasterPreview } from './raster-preview.js';
import { decodeText } from './text-encoding.js';
import { commitFiles } from './commit-files.js';
import { parsePatch } from './patch.js';
import { GitError, type RunOptions, type runGit } from './runner.js';
type Run = (args: string[], options?: RunOptions) => ReturnType<typeof runGit>;
const SOFT_BYTES = 2 * 1024 * 1024;
const HARD_BYTES = 20 * 1024 * 1024;
const SOFT_LINES = 10000;
const HARD_LINES = 250000;
async function version(
  run: Run,
  oid: string | undefined,
  mode: string,
  allowLarge: boolean,
  encoding: CommitComparisonOptions['encoding'],
  signal?: AbortSignal,
): Promise<FileVersion> {
  if (!oid) return { kind: 'missing', bytes: 0, mode };
  if (mode === '160000') return { kind: 'submodule', oid, mode, bytes: 0 };
  const bytes = Number(
    (await run(['cat-file', '-s', oid], { signal, maxBytes: 128 })).stdout.toString().trim(),
  );
  if (!Number.isSafeInteger(bytes) || bytes < 0)
    throw new GitError('INVALID_OBJECT', 'Git returned an invalid blob size');
  if (bytes > (allowLarge ? HARD_BYTES : SOFT_BYTES)) return { kind: 'large', oid, mode, bytes };
  const content = (await run(['cat-file', 'blob', oid], { signal, maxBytes: HARD_BYTES })).stdout;
  const image = rasterPreview(content);
  if (image) return { kind: 'image', oid, mode, bytes, image };
  const decoded = decodeText(content, encoding);
  if (!decoded) return { kind: 'binary', oid, mode, bytes };
  const { text } = decoded;
  let lines = text.length && !text.endsWith('\n') ? 1 : 0;
  for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) === 10) lines++;
  if (lines > (allowLarge ? HARD_LINES : SOFT_LINES))
    return { kind: 'large', oid, mode, bytes, lines, encoding: decoded.encoding };
  return { kind: 'text', oid, mode, bytes, text, encoding: decoded.encoding, lines };
}
export async function commitComparison(
  run: Run,
  input: CommitComparisonOptions,
  signal?: AbortSignal,
) {
  const options = commitComparisonOptionsSchema.parse(input);
  const changed = await commitFiles(run, options.commit, options.parent, signal);
  const file = changed.files.find((file) => file.pathBytes === options.pathBytes);
  if (!file) throw new GitError('UNKNOWN_FILE', 'Select a file changed by this commit');
  const [oldVersion, newVersion] = await Promise.all([
    version(run, file.oldOid, file.oldMode, !!options.allowLarge, options.encoding, signal),
    version(run, file.newOid, file.newMode, !!options.allowLarge, options.encoding, signal),
  ]);
  const whitespace = options.whitespace ?? 'exact';
  const large = [oldVersion, newVersion].filter((version) => version.kind === 'large');
  if (large.length) {
    const bytes = large.some((version) => version.lines === undefined);
    const canLoad = large.every(
      (version) => version.bytes <= HARD_BYTES && (version.lines ?? 0) <= HARD_LINES,
    );
    return fileComparisonSchema.parse({
      file,
      oldVersion,
      newVersion,
      whitespace,
      hunks: [],
      guard: {
        reason: bytes ? 'bytes' : 'lines',
        limit: bytes
          ? options.allowLarge
            ? HARD_BYTES
            : SOFT_BYTES
          : options.allowLarge
            ? HARD_LINES
            : SOFT_LINES,
        canLoad,
      },
    });
  }
  if ([oldVersion, newVersion].some((version) => !['missing', 'text'].includes(version.kind)))
    return fileComparisonSchema.parse({ file, oldVersion, newVersion, whitespace, hunks: [] });
  const directory = await mkdtemp(join(tmpdir(), 'openkraken-file-diff-'));
  try {
    const oldPath = join(directory, 'before'),
      newPath = join(directory, 'after');
    await Promise.all([
      writeFile(oldPath, oldVersion.text ?? '', { mode: 0o600, flag: 'wx' }),
      writeFile(newPath, newVersion.text ?? '', { mode: 0o600, flag: 'wx' }),
    ]);
    const flags = {
      exact: [],
      all: ['--ignore-all-space'],
      changes: ['--ignore-space-change'],
      eol: ['--ignore-space-at-eol'],
    };
    const output = await run(
      [
        'diff',
        '--no-index',
        '--no-ext-diff',
        '--no-textconv',
        '--no-color',
        '--text',
        '--unified=3',
        ...flags[whitespace],
        '--',
        oldPath,
        newPath,
      ],
      { signal, maxBytes: 32 * 1024 * 1024, allowedExitCodes: [0, 1], timeoutMs: 30000 },
    );
    const { hunks } = parsePatch(output.stdout.toString('utf8'), file.path);
    return fileComparisonSchema.parse({ file, oldVersion, newVersion, whitespace, hunks });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
