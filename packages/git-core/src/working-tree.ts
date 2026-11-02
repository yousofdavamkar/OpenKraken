import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  rm,
  open,
  copyFile,
  stat,
  readdir,
  utimes,
} from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import {
  headSchema,
  workingFileOptionsSchema,
  saveWorkingFileSchema,
  type WorkingFileOptions,
  type WorkingComparisonOptions,
  type SaveWorkingFile,
  oidSchema,
  referenceOptionsSchema,
  stashPushOptionsSchema,
  stashActionOptionsSchema,
  type StashActionOptions,
  pullOptionsSchema,
  type PullOptions,
  type OperationState,
  type OperationAction,
  operationActionSchema,
  startOperationSchema,
  type StartOperation,
  type InteractiveRebase,
  interactiveRebaseSchema,
  interactiveRebasePreviewSchema,
  type ResetSelection,
  type ResolveConflict,
  resolveConflictSchema,
  resetSelectionSchema,
  type StashPushOptions,
  type ReferenceOptions,
  type WorkingState,
  type WorkingDiff,
  type PatchOptions,
  type Repository,
} from '@openkraken/ipc-contract';
import { workingComparison } from './working-comparison.js';
import { readWorkingFile, encodeWorkingFile } from './working-file.js';
import { GitError, runGit, type RunOptions } from './runner.js';
import { StashStore } from './stash.js';
import { Conflicts } from './conflicts.js';
import { inspectOperation } from './operation-state.js';
import { openGitEditor } from './editor.js';
import { editRebaseFile } from './rebase-editor.js';
import type { GitEditor } from './editor-document.js';
import { GitProgressLines, redactGitMessage } from './progress.js';
import { RepositoryQueue } from './queue.js';
import { FileBackups, fileImageSchema, sameImages, type FileImage } from './file-backups.js';
import { BranchConfiguration } from './branch-config.js';
import { parsePatch, selectPatch } from './patch.js';
import { StatusParser, NulDecoder } from './parsers.js';
const MAX_INDEX = 32 * 1024 * 1024;
const savedSchema = z.object({
  head: headSchema,
  index: z.string().max(MAX_INDEX * 2),
  signature: z.string(),
  files: z.array(fileImageSchema).optional(),
  branchConfig: z.record(z.string(), z.array(z.string())).optional(),
  refs: z.record(z.string().regex(/^refs\/(heads|tags)\/[^\s]+$/), oidSchema.nullable()).optional(),
});
const entrySchema = z.object({
  id: z.string().uuid(),
  label: z.string(),
  before: savedSchema,
  after: savedSchema,
  trees: z.object({ before: oidSchema, after: oidSchema }).optional(),
});
const journalSchema = z.object({
  undo: z.array(entrySchema).max(20),
  redo: z.array(entrySchema).max(20),
});
const operationOriginSchema = z.object({
  id: z.string().uuid(),
  label: z.string(),
  before: savedSchema,
  beforeTree: oidSchema,
  undoIds: z.array(z.string().uuid()).max(20),
  identity: z.string(),
  plan: interactiveRebaseSchema.optional(),
});
type OperationOrigin = z.infer<typeof operationOriginSchema>;
type Saved = z.infer<typeof savedSchema>;
type Journal = z.infer<typeof journalSchema>;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const sameHead = (a: Repository['head'], b: Repository['head']) =>
  JSON.stringify(a) === JSON.stringify(b);
async function atomic(path: string, data: string) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, data, { flag: 'wx', mode: 0o600 });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}
async function copyIndex(source: string, target: string) {
  const metadata = await stat(source);
  await copyFile(source, target);
  // A fresh timestamp would make a copied index trust racy cached file stats.
  // Round down to retain the source index's conservative content checks.
  await utimes(target, metadata.atime, new Date(Math.floor(metadata.mtimeMs / 1000) * 1000));
}
/** Git writes are serialized by RepositoryService and protected from external index writers. */
export class WorkingTree {
  private directory: string;
  private backups: FileBackups;
  private configuration: BranchConfiguration;
  private processes = new RepositoryQueue(3);
  constructor(
    private git: string,
    readonly repo: Repository,
    dataDir: string,
    private editorHelper?: string,
  ) {
    if (!/^[0-9a-f]{64}$/.test(repo.id)) throw new Error('Invalid repository');
    this.directory = join(dataDir, 'undo', repo.id);
    this.backups = new FileBackups(repo.path, this.directory);
    this.configuration = new BranchConfiguration(repo.commonDir, this.directory, (args, options) =>
      this.run(args, options),
    );
  }
  private run(args: string[], options: RunOptions = {}) {
    return this.processes.run(
      false,
      () => runGit(this.git, ['--literal-pathspecs', ...args], { cwd: this.repo.path, ...options }),
      options.signal,
    );
  }
  private async head(signal?: AbortSignal): Promise<Repository['head']> {
    const [ref, oid] = await Promise.all([
      this.run(['symbolic-ref', '-q', 'HEAD'], { signal, allowedExitCodes: [0, 1] }),
      this.run(['rev-parse', '--verify', '--quiet', 'HEAD'], { signal, allowedExitCodes: [0, 1] }),
    ]);
    const name = ref.stdout.toString().trim(),
      target = oid.stdout.toString().trim();
    return name
      ? { kind: 'branch', ref: name, ...(target ? { oid: target } : {}) }
      : { kind: 'detached', oid: target };
  }
  private async journal(): Promise<Journal> {
    try {
      if ((await stat(join(this.directory, 'journal.json'))).size > 128 * 1024 * 1024)
        throw new Error('Journal exceeds size limit');
      return journalSchema.parse(
        JSON.parse(await readFile(join(this.directory, 'journal.json'), 'utf8')),
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { undo: [], redo: [] };
      throw new GitError(
        'UNDO_UNAVAILABLE',
        'Cannot read the undo journal; existing backups have been preserved',
      );
    }
  }
  private async saveJournal(journal: Journal) {
    const retainedBytes = () => {
      const unique = new Map<string, number>();
      for (const entry of [...journal.undo, ...journal.redo])
        for (const file of [...(entry.before.files ?? []), ...(entry.after.files ?? [])])
          if (file.digest) unique.set(file.digest, file.bytes ?? 0);
      return [...unique.values()].reduce((n, bytes) => n + bytes, 0);
    };
    while (journal.undo.length + journal.redo.length > 20 || retainedBytes() > 512 * 1024 * 1024) {
      if (journal.undo.length > 1) journal.undo.shift();
      else if (journal.redo.length) journal.redo.shift();
      else throw new GitError('UNDO_LIMIT', 'File backups exceed the 512 MiB journal limit');
    }
    let data = JSON.stringify(journal);
    while (Buffer.byteLength(data) > 128 * 1024 * 1024 && journal.undo.length > 1) {
      journal.undo.shift();
      data = JSON.stringify(journal);
    }
    if (Buffer.byteLength(data) > 128 * 1024 * 1024)
      throw new GitError('UNDO_LIMIT', 'Undo backup exceeds 128 MiB');
    await atomic(join(this.directory, 'journal.json'), data);
  }
  async state(signal?: AbortSignal): Promise<WorkingState> {
    const parser = new StatusParser();
    if (!this.repo.isBare)
      await this.run(
        ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all', '--renames'],
        { signal, onStdout: (b) => parser.push(b) },
      );
    const journal = await this.journal();
    const brief = (entry?: z.infer<typeof entrySchema>) =>
      entry ? { id: entry.id, label: entry.label } : undefined;
    const fingerprint = this.repo.isBare
      ? { head: await this.head(signal), signature: '' }
      : await this.fingerprint();
    const details = this.repo.isBare
      ? {}
      : await this.commitInfo(fingerprint.head.oid, signal).catch((error: unknown) => ({
          commitWarning: error instanceof Error ? error.message : String(error),
        }));
    return {
      operation: await this.operationState(signal),
      status: parser.finish(),
      head: fingerprint.head,
      revision: this.revision(fingerprint),
      undo: brief(journal.undo.at(-1)),
      redo: brief(journal.redo.at(-1)),
      ...details,
    };
  }
  private revision(value: { head: Repository['head']; signature: string }) {
    return hash(JSON.stringify(value.head) + value.signature);
  }
  private async fingerprint(indexFile?: string) {
    const [head, entries, diff] = await Promise.all([
      this.head(),
      this.run(['ls-files', '--stage', '-v', '-z'], { indexFile }),
      this.run(['diff', '--cached', '--raw', '-z', '--no-ext-diff', '--no-renames'], { indexFile }),
    ]);
    return { head, signature: hash(Buffer.concat([entries.stdout, diff.stdout])) };
  }
  private async saved(
    indexFile: string,
    files?: string[],
    signal?: AbortSignal,
    refs?: string[],
    config?: string[],
  ): Promise<Saved> {
    if ((await stat(indexFile)).size > MAX_INDEX)
      throw new GitError('UNDO_LIMIT', 'The index exceeds the 32 MiB undo limit');
    const index = await readFile(indexFile);
    if (index.length > MAX_INDEX)
      throw new GitError('UNDO_LIMIT', 'The index exceeds the 32 MiB undo limit');
    return {
      index: index.toString('base64'),
      ...(refs ? { refs: await this.referenceState(refs, signal) } : {}),
      ...(config ? { branchConfig: await this.branchConfiguration(config, signal) } : {}),
      ...(await this.fingerprint(indexFile)),
      ...(files ? { files: await this.backups.capture(files, true, signal) } : {}),
    };
  }
  private async commitInfo(oid?: string, signal?: AbortSignal) {
    const [template, sign, commit] = await Promise.all([
      this.run(['config', '--path', '--get', 'commit.template'], {
        signal,
        allowedExitCodes: [0, 1],
      }),
      this.run(['config', '--bool', '--get', 'commit.gpgSign'], {
        signal,
        allowedExitCodes: [0, 1],
      }),
      oid
        ? this.run(['cat-file', 'commit', oid], { signal, maxBytes: 4 * 1024 * 1024 })
        : undefined,
    ]);
    let messageTemplate = '';
    const configured = template.stdout.toString().trim();
    if (configured) {
      const path = isAbsolute(configured) ? configured : join(this.repo.path, configured);
      if ((await stat(path)).size > 65536)
        throw new GitError('TEMPLATE_LIMIT', 'Commit message template exceeds 64 KiB');
      messageTemplate = await readFile(path, 'utf8');
    }
    const raw = commit?.stdout.toString('utf8');
    return {
      messageTemplate,
      amendMessage: raw?.slice(raw.indexOf('\n\n') + 2),
      signing: sign.stdout.toString().trim() === 'true',
    };
  }
  private async locked<T>(
    work: (index: string, publish: () => Promise<void>) => Promise<T>,
    signal?: AbortSignal,
    allowBare = false,
  ) {
    if (this.repo.isBare && !allowBare)
      throw new GitError('BARE_REPOSITORY', 'This repository has no working tree');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lockPath = join(this.repo.gitDir, 'index.lock');
    let lock;
    try {
      lock = await open(lockPath, 'wx', 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST')
        throw new GitError(
          'INDEX_LOCKED',
          'Another Git operation holds index.lock. Wait for it to finish.',
        );
      throw e;
    }
    const index = join(this.directory, `index-${randomUUID()}`);
    let published = false;
    try {
      if (signal?.aborted) throw new GitError('CANCELLED', 'Operation cancelled');
      try {
        await copyIndex(join(this.repo.gitDir, 'index'), index);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        await this.run(['read-tree', '--empty'], { indexFile: index, readOnly: false, signal });
      }
      // The profile backup must not depend on a shared-index file that Git may later remove.
      await this.run(['update-index', '--no-split-index'], {
        indexFile: index,
        readOnly: false,
        signal,
      });
      return await work(index, async () => {
        const contents = await readFile(index);
        await lock.writeFile(contents);
        await lock.sync();
        await lock.close();
        await rename(lockPath, join(this.repo.gitDir, 'index'));
        published = true;
      });
    } finally {
      await lock.close().catch(() => {});
      if (!published) await rm(lockPath, { force: true });
      await rm(index, { force: true });
      await rm(`${index}.lock`, { force: true });
    }
  }
  private async transaction(
    label: string,
    change: (index: string, before: Saved) => Promise<void>,
    signal?: AbortSignal,
    files?: string[],
    movesHead = false,
    refs?: string[],
    config?: string[],
  ) {
    await this.locked(
      async (index, publish) => {
        const journal = await this.journal();
        await this.pruneFiles(journal);
        const before = await this.saved(index, files, signal, refs, config),
          id = randomUUID();
        const pending = join(this.directory, `pending-${id}.json`);
        await atomic(pending, JSON.stringify({ id, label, before }));
        let failure: unknown;
        try {
          await change(index, before);
        } catch (error) {
          failure = error;
        }
        const after = await this.saved(index, files, undefined, refs, config);
        if (!movesHead && !sameHead(before.head, after.head))
          throw new GitError(
            'CONCURRENT_HEAD',
            `HEAD changed during the operation; the index was not published. Recovery backup: ${pending}`,
          );
        if (
          !sameHead(before.head, after.head) ||
          before.signature !== after.signature ||
          !sameImages(before.files, after.files) ||
          JSON.stringify(before.refs) !== JSON.stringify(after.refs) ||
          JSON.stringify(before.branchConfig) !== JSON.stringify(after.branchConfig)
        ) {
          journal.undo.push({ id, label, before, after });
          journal.redo = [];
          await this.saveJournal(journal);
          if (
            (!this.repo.isBare && !sameHead(before.head, after.head)) ||
            before.signature !== after.signature
          )
            await publish();
        }
        await rm(pending, { force: true });
        await this.pruneFiles(journal);
        if (failure) throw failure;
      },
      signal,
      !!refs,
    );
    return this.state();
  }
  private async paths(selected: string[], signal?: AbortSignal) {
    if (!selected.length || selected.length > 10000)
      throw new GitError('INVALID_PATH', 'Select between one and 10,000 files');
    const { status } = await this.state(signal);
    const paths = new Map<string, Buffer>();
    for (const encoded of selected) {
      const path = Buffer.from(encoded, 'base64');
      if (
        path.toString('base64') !== encoded ||
        path.includes(0) ||
        path[0] === 47 ||
        path
          .toString()
          .split('/')
          .some((p) => !p || p === '..' || p === '.' || p.toLowerCase() === '.git')
      )
        throw new GitError('INVALID_PATH', 'Invalid repository-relative path');
      const entry = status.entries.find((e) => e.pathBytes === encoded);
      if (!entry)
        throw new GitError('STALE_STATUS', 'The selected file changed; refresh the working tree');
      paths.set(encoded, path);
      if (entry.origPathBytes)
        paths.set(entry.origPathBytes, Buffer.from(entry.origPathBytes, 'base64'));
    }
    return Buffer.concat([...paths.values()].flatMap((p) => [p, Buffer.from([0])]));
  }
  async operationState(signal?: AbortSignal, indexFile?: string): Promise<OperationState> {
    const metadata = await inspectOperation(this.repo.gitDir);
    const fingerprint = await this.fingerprint(indexFile);
    let images: FileImage[] = [];
    let conflicts = 0;
    if (metadata.details.kind !== 'none' && !this.repo.isBare) {
      const parser = new StatusParser();
      await this.run(['status', '--porcelain=v2', '-z', '--untracked-files=no'], {
        indexFile,
        signal,
        onStdout: (chunk) => parser.push(chunk),
      });
      const entries = parser.finish().entries;
      conflicts = entries.filter((entry) => entry.kind === 'conflict').length;
      const paths = [
        ...new Set(
          entries
            .filter((entry) => !entry.submodule.startsWith('S'))
            .flatMap((entry) => [
              entry.pathBytes,
              ...(entry.origPathBytes ? [entry.origPathBytes] : []),
            ]),
        ),
      ];
      images = await this.backups.capture(paths, false, signal);
    }
    return {
      ...metadata.details,
      conflicts,
      token: hash(metadata.fingerprint + JSON.stringify(fingerprint) + JSON.stringify(images)),
    };
  }
  private async conflictContext(pathBytes: string, signal?: AbortSignal, indexFile?: string) {
    const metadata = await inspectOperation(this.repo.gitDir);
    const revision = hash(this.revision(await this.fingerprint(indexFile)) + metadata.fingerprint);
    const configured = await this.run(
      ['config', '--null', '--get-regexp', '^(merge\\.(gui)?tool|mergetool\\..*)$'],
      { signal, allowedExitCodes: [0, 1], maxBytes: 65536 },
    );
    const settings = new Map<string, string>();
    const parser = new NulDecoder((field) => {
      const newline = field.indexOf(10);
      if (newline >= 0)
        settings.set(
          field.subarray(0, newline).toString().toLowerCase(),
          field.subarray(newline + 1).toString(),
        );
    });
    parser.push(configured.stdout);
    parser.finish();
    const name = settings.get('merge.guitool') ?? settings.get('merge.tool');
    const result = await new Conflicts(
      (args, options) => this.run(args, options),
      this.backups,
    ).inspect(pathBytes, revision, metadata.details.kind, signal, indexFile);
    result.preview.externalTool = name && /^[a-zA-Z0-9_-]{1,128}$/.test(name) ? name : undefined;
    result.preview.token = hash(result.preview.token + configured.stdout.toString('base64'));
    return result;
  }

  async conflictPreview(pathBytes: string, signal?: AbortSignal) {
    return (await this.conflictContext(pathBytes, signal)).preview;
  }
  async resolveConflict(input: ResolveConflict, signal?: AbortSignal) {
    const options = resolveConflictSchema.parse(input);
    const reviewed = await this.conflictContext(options.pathBytes, signal);
    if (reviewed.preview.token !== options.token)
      throw new GitError('STALE_CONFLICT', 'The conflict changed. Reopen it before resolving.');
    return this.transaction(
      'Resolve conflict',
      async (indexFile, before) => {
        const current = await this.conflictContext(options.pathBytes, signal, indexFile);
        if (
          current.preview.token !== options.token ||
          !sameImages(before.files, current.image ? [current.image] : undefined)
        )
          throw new GitError('STALE_CONFLICT', 'The conflict changed. Reopen it before resolving.');
        const stdin = Buffer.concat([Buffer.from(options.pathBytes, 'base64'), Buffer.from([0])]);
        if (options.choice === 'external') {
          const tool = current.preview.externalTool;
          if (!tool)
            throw new GitError(
              'MERGETOOL_NOT_CONFIGURED',
              'Configure Git merge.tool or merge.guitool before opening an external merge tool.',
            );
          if (current.preview.working.kind === 'submodule')
            throw new GitError(
              'SUBMODULE_OPERATION',
              'Choose a submodule commit pointer here or resolve it inside the submodule.',
            );
          const path = Buffer.from(options.pathBytes, 'base64');
          if (!Buffer.from(path.toString('utf8')).equals(path))
            throw new GitError(
              'EXTERNAL_TOOL_PATH',
              'External merge tools require a UTF-8 filename. Use a whole-side choice instead.',
            );
          await this.run(
            ['mergetool', '--no-prompt', `--tool=${tool}`, '--', path.toString('utf8')],
            { indexFile, signal, readOnly: false, timeoutMs: 1800000 },
          );
          return;
        }

        if (options.choice !== 'output') {
          const chosen = options.choice === 'delete' ? undefined : current.preview[options.choice];
          const stageChoice = async () => {
            const clear = Buffer.concat([
              Buffer.from(
                `0 ${'0'.repeat((current.preview.ours ?? current.preview.theirs ?? current.preview.base)!.oid.length)}\t`,
              ),
              stdin,
            ]);
            const selected = chosen
              ? Buffer.concat([Buffer.from(`${chosen.mode} ${chosen.oid} 0\t`), stdin])
              : Buffer.alloc(0);
            await this.run(['update-index', '-z', '--index-info'], {
              indexFile,
              signal,
              readOnly: false,
              stdin: Buffer.concat([clear, selected]),
            });
          };
          if (!chosen || chosen.mode === '160000') {
            if (!chosen && current.image) await this.backups.trash(current.image, signal);
            await stageChoice();
            return;
          }
          if (current.preview.working.kind === 'submodule')
            throw new GitError(
              'CONFLICT_TYPE_UNSUPPORTED',
              'Resolve file/submodule type changes with Git. Submodule working files were left unchanged.',
            );
          if (chosen.bytes > 64 * 1024 * 1024)
            throw new GitError('UNDO_LIMIT', 'This conflict side exceeds the 64 MiB backup limit.');
          await this.run(
            [
              'checkout-index',
              `--stage=${options.choice === 'ours' ? '2' : '3'}`,
              '--force',
              '-z',
              '--stdin',
            ],
            { indexFile, signal, readOnly: false, stdin },
          );
          await stageChoice();
          return;
        } else {
          if (!current.preview.editable)
            throw new GitError(
              'CONFLICT_NOT_EDITABLE',
              'This conflict cannot be saved as UTF-8 text. Choose a side or use an external tool.',
            );
          const bytes = Buffer.from(options.text, 'utf8');
          if (
            bytes.length > 2 * 1024 * 1024 ||
            bytes.includes(0) ||
            bytes.toString('utf8') !== options.text
          )
            throw new GitError(
              'CONFLICT_OUTPUT_LIMIT',
              'Conflict output must be UTF-8 text without NUL, at most 2 MiB.',
            );
          await this.backups.write(
            options.pathBytes,
            bytes,
            current.image?.mode ?? (current.preview.ours?.mode === '100755' ? 0o755 : 0o644),
            signal,
          );
        }
        await this.run(['add', '--pathspec-from-file=-', '--pathspec-file-nul'], {
          indexFile,
          signal,
          readOnly: false,
          stdin,
        });
      },
      signal,
      reviewed.image ? [options.pathBytes] : undefined,
    );
  }
  private async resetContext(input: ResetSelection, signal?: AbortSignal, indexFile?: string) {
    const selection = resetSelectionSchema.parse(input);
    if (this.repo.isBare)
      throw new GitError('BARE_REPOSITORY', 'This repository has no working tree');
    await this.noOperation();
    await this.run(['cat-file', '-e', `${selection.target}^{commit}`], { signal });
    const fingerprint = await this.fingerprint(indexFile);
    if (!fingerprint.head.oid)
      throw new GitError('UNBORN_HEAD', 'Create an initial commit before resetting.');
    const paths = new Set<string>();
    if (selection.mode === 'hard') {
      const collect = async (args: string[]) => {
        const parser = new NulDecoder((path) => {
          paths.add(path.toString('base64'));
          if (paths.size > 10000)
            throw new GitError('UNDO_LIMIT', 'Hard reset backups are limited to 10,000 paths.');
        });
        await this.run(args, { signal, indexFile, onStdout: (chunk) => parser.push(chunk) });
        parser.finish();
      };
      // Capture all tracked paths, including edits hidden by assume-unchanged flags.
      await collect(['ls-files', '--cached', '-z']);
      await collect(['ls-tree', '-r', '--name-only', '-z', selection.target]);
      let targetBytes = 0;
      const targetSizes = new NulDecoder((record) => {
        const header = record.subarray(0, record.indexOf(9)).toString().trim().split(/\s+/);
        if (header[1] === 'commit')
          throw new GitError(
            'SUBMODULE_OPERATION',
            'Hard reset with submodule paths is not supported yet.',
          );
        const size = Number(header[3]);
        targetBytes += size;
        if (
          !Number.isSafeInteger(size) ||
          size > 64 * 1024 * 1024 ||
          targetBytes > 128 * 1024 * 1024
        )
          throw new GitError(
            'UNDO_LIMIT',
            'The target tree exceeds hard reset backup limits (64 MiB per file, 128 MiB total).',
          );
      });
      await this.run(['ls-tree', '-r', '--long', '-z', selection.target], {
        signal,
        onStdout: (chunk) => targetSizes.push(chunk),
      });
      targetSizes.finish();
      const trackedModes = new NulDecoder((record) => {
        if (record.subarray(0, 6).toString() === '160000')
          throw new GitError(
            'SUBMODULE_OPERATION',
            'Hard reset with submodule paths is not supported yet.',
          );
      });
      await this.run(['ls-files', '--stage', '-z'], {
        indexFile,
        signal,
        onStdout: (chunk) => trackedModes.push(chunk),
      });
      trackedModes.finish();
    }
    const files =
      selection.mode === 'hard'
        ? await this.backups.capture([...paths].sort(), false, signal)
        : undefined;
    return {
      selection,
      fingerprint,
      files,
      token: hash(JSON.stringify({ selection, ...fingerprint, files })),
    };
  }
  async resetPreview(selection: ResetSelection, signal?: AbortSignal) {
    const context = await this.resetContext(selection, signal);
    return {
      token: context.token,
      head: context.fingerprint.head,
      files: context.files?.length ?? 0,
      bytes: context.files?.reduce((sum, file) => sum + (file.bytes ?? 0), 0) ?? 0,
    };
  }
  async reset(selection: ResetSelection, token: string, signal?: AbortSignal) {
    const reviewed = await this.resetContext(selection, signal);
    if (reviewed.token !== token)
      throw new GitError('STALE_RESET', 'Repository contents changed. Review the reset again.');
    return this.transaction(
      `Reset (${selection.mode})`,
      async (indexFile, before) => {
        const current = await this.resetContext(selection, signal, indexFile);
        if (current.token !== token || !sameImages(before.files, current.files))
          throw new GitError('STALE_RESET', 'Repository contents changed. Review the reset again.');
        await this.run(['reset', `--${selection.mode}`, selection.target, '--'], {
          indexFile,
          signal,
          readOnly: false,
          timeoutMs: 180000,
        });
      },
      signal,
      reviewed.files?.map((file) => file.pathBytes),
      true,
    );
  }
  async startOperation(
    input: StartOperation,
    signal?: AbortSignal,
    onProgress?: (text: string) => void,
  ) {
    const options = startOperationSchema.parse(input);
    await this.locked(async (indexFile, publish) => {
      await this.noOperation();
      const state = await this.state(signal);
      if (state.revision !== options.revision)
        throw new GitError(
          'STALE_OPERATION',
          'HEAD or staged files changed. Review the current branch before starting.',
        );
      if (!state.head.oid)
        throw new GitError(
          'UNBORN_HEAD',
          'Create an initial commit before starting this operation.',
        );
      if (state.status.entries.some((entry) => !['untracked', 'ignored'].includes(entry.kind)))
        throw new GitError(
          'OPERATION_DIRTY',
          'Commit or stash tracked changes before starting this operation.',
        );
      await this.run(['cat-file', '-e', `${options.target}^{commit}`], { signal });
      let args: string[];
      if (options.kind === 'merge')
        args = ['merge', `--${options.mode}`, '--no-autostash', '--no-edit', options.target];
      else if (options.kind === 'rebase')
        args = [
          'rebase',
          '--merge',
          '--no-autostash',
          '--no-update-refs',
          '--no-rebase-merges',
          options.target,
        ];
      else {
        const parents = (
          await this.run(['rev-list', '--parents', '-1', options.target], { signal })
        ).stdout
          .toString()
          .trim()
          .split(' ')
          .slice(1);
        if (parents.length > 1 && !options.mainline)
          throw new GitError(
            'MAINLINE_REQUIRED',
            'Choose the mainline parent number for this merge commit (starting at 1).',
          );
        if (options.mainline && options.mainline > parents.length)
          throw new GitError(
            'INVALID_MAINLINE',
            'The selected mainline parent does not exist in this commit.',
          );
        args = [
          options.kind,
          '--no-edit',
          ...(options.mainline ? ['--mainline', String(options.mainline)] : []),
          options.target,
        ];
      }
      await this.runOperation(
        args,
        options.kind === 'merge' ? `Merge (${options.mode})` : options.kind,
        indexFile,
        publish,
        signal,
        onProgress,
        true,
      );
    }, signal);
    return this.state();
  }
  async interactiveRebasePreview(input: string, signal?: AbortSignal) {
    const base = oidSchema.parse(input);
    await this.noOperation();
    const state = await this.state(signal);
    if (!state.head.oid) throw new GitError('UNBORN_HEAD', 'Create a commit before rebasing');
    if (state.status.entries.some((entry) => !['untracked', 'ignored'].includes(entry.kind)))
      throw new GitError('REBASE_DIRTY', 'Commit or stash tracked changes before rebasing');
    const ancestor = await this.run(['merge-base', '--is-ancestor', base, state.head.oid], {
      signal,
      allowedExitCodes: [0, 1],
    });
    if (ancestor.exitCode)
      throw new GitError('REBASE_BASE', 'Choose an ancestor of HEAD as the rebase base');
    const range = `${base}..${state.head.oid}`;
    const ancestry = (
      await this.run(['rev-list', '--parents', '--max-count=501', range], {
        signal,
        maxBytes: 131072,
      })
    ).stdout
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean);
    if (!ancestry.length || ancestry.length > 500)
      throw new GitError('REBASE_LIMIT', 'Review between 1 and 500 commits');
    if (ancestry.some((line) => line.split(' ').length > 2))
      throw new GitError('REBASE_MERGES', 'This editor currently requires a linear commit range');
    const output = await this.run(
      [
        '-c',
        'i18n.logOutputEncoding=UTF-8',
        'log',
        '--reverse',
        '--topo-order',
        '--no-show-signature',
        '--format=%H%x00%B%x00',
        range,
      ],
      { signal, maxBytes: 2 * 1024 * 1024 },
    );
    let fields: string[];
    try {
      fields = new TextDecoder('utf-8', { fatal: true }).decode(output.stdout).split('\0');
    } catch {
      throw new GitError('REBASE_ENCODING', 'Commit messages must decode as UTF-8 for this editor');
    }
    const commits: { oid: string; message: string }[] = [];
    for (let i = 0; i + 1 < fields.length; i += 2)
      commits.push({ oid: oidSchema.parse(fields[i]!.trim()), message: fields[i + 1]! });
    if (commits.length !== ancestry.length)
      throw new GitError('REBASE_CHANGED', 'Commit history changed during review');
    return interactiveRebasePreviewSchema.parse({
      base,
      head: state.head,
      commits,
      token: hash(JSON.stringify({ base, revision: state.revision, commits })),
    });
  }
  async interactiveRebase(
    input: InteractiveRebase,
    signal?: AbortSignal,
    onProgress?: (text: string) => void,
    edit?: GitEditor,
  ) {
    const plan = interactiveRebaseSchema.parse(input);
    if (!this.editorHelper)
      throw new GitError('EDITOR_UNAVAILABLE', 'The native Git editor helper is unavailable');
    await this.locked(async (indexFile, publish) => {
      const preview = await this.interactiveRebasePreview(plan.base, signal);
      if (preview.token !== plan.token)
        throw new GitError(
          'STALE_REBASE',
          'History or staged files changed. Review the rebase again',
        );
      const ids = new Set(preview.commits.map((commit) => commit.oid));
      if (
        plan.steps.length !== ids.size ||
        new Set(plan.steps.map((step) => step.oid)).size !== ids.size ||
        plan.steps.some((step) => !ids.has(step.oid))
      )
        throw new GitError('INVALID_REBASE_PLAN', 'Every reviewed commit must appear exactly once');
      let picked = false;
      for (const step of plan.steps) {
        if (['squash', 'fixup'].includes(step.action) && !picked)
          throw new GitError(
            'INVALID_REBASE_PLAN',
            'Squash and fixup need an earlier retained commit',
          );
        if (step.action !== 'drop') picked = true;
      }
      if (Buffer.byteLength(JSON.stringify(plan)) > 2 * 1024 * 1024)
        throw new GitError('REBASE_LIMIT', 'The reviewed plan exceeds 2 MiB');
      await this.runOperation(
        [
          '-c',
          'rebase.instructionFormat=%s',
          'rebase',
          '--interactive',
          '--no-autosquash',
          '--no-autostash',
          '--no-update-refs',
          '--no-rebase-merges',
          '--reapply-cherry-picks',
          '--keep-empty',
          '--empty=keep',
          plan.base,
        ],
        'Interactive rebase',
        indexFile,
        publish,
        signal,
        onProgress,
        true,
        false,
        plan,
        edit,
      );
    }, signal);
    return this.state();
  }
  private async runOperation(
    args: string[],
    label: string,
    indexFile: string,
    publish: () => Promise<void>,
    signal?: AbortSignal,
    onProgress?: (text: string) => void,
    recordUndo: boolean | OperationOrigin = false,
    discardUndo = false,
    plan?: InteractiveRebase,
    edit?: GitEditor,
  ) {
    const before = await this.saved(indexFile);
    const id = randomUUID();
    const origin =
      recordUndo === true
        ? {
            id,
            label,
            before,
            beforeTree: await this.indexTree(indexFile, signal),
            undoIds: (await this.journal()).undo.map((entry) => entry.id),
            identity: '',
            plan,
          }
        : recordUndo || undefined;
    const pending = join(this.directory, `pending-${id}.json`);
    const record = { id, label, before, origin };
    await atomic(pending, JSON.stringify(record));
    const progress = onProgress ? new GitProgressLines(onProgress) : undefined;
    let failure: unknown;
    let editor: Awaited<ReturnType<typeof openGitEditor>> | undefined;
    let editorFailure: unknown;
    try {
      if (origin?.plan && !discardUndo) {
        if (!this.editorHelper)
          throw new GitError('EDITOR_UNAVAILABLE', 'The native Git editor helper is unavailable');
        editor = await openGitEditor(
          this.editorHelper,
          async (path, editorSignal) => {
            try {
              await editRebaseFile(this.repo, origin.plan!, path, editorSignal, edit);
            } catch (error) {
              editorFailure = error;
              throw error;
            }
          },
          signal,
        );
      }
      const result = await this.run(args, {
        indexFile,
        signal,
        readOnly: false,
        allowedExitCodes: [0, 1],
        timeoutMs: 180000,
        env: editor?.environment ?? { GIT_EDITOR: 'true' },
        onStderr: progress ? (chunk) => progress.push(chunk) : undefined,
      });
      if (result.exitCode)
        throw new GitError(
          'GIT_FAILED',
          redactGitMessage(`${result.stdout.toString()}\n${result.stderr}`.trim()),
        );
    } catch (error) {
      failure =
        error instanceof GitError && error.code === 'CANCELLED' ? error : (editorFailure ?? error);
    } finally {
      progress?.end();
      await editor?.close();
    }
    const after = await this.saved(indexFile);
    await atomic(pending, JSON.stringify({ ...record, after }));
    const operation = await inspectOperation(this.repo.gitDir);
    if (
      origin &&
      operation.details.kind === 'none' &&
      (origin.identity ||
        !sameHead(origin.before.head, after.head) ||
        origin.before.signature !== after.signature)
    ) {
      const journal = await this.journal();
      // Resolution/staging entries belong to this operation, not to its finished history.
      journal.undo = journal.undo.filter((entry) => origin.undoIds.includes(entry.id));
      if (
        !failure &&
        !discardUndo &&
        (!sameHead(origin.before.head, after.head) || origin.before.signature !== after.signature)
      )
        journal.undo.push({
          id: origin.id,
          label: origin.label,
          before: origin.before,
          after,
          trees: { before: origin.beforeTree, after: await this.indexTree(indexFile) },
        });
      journal.redo = [];
      await this.saveJournal(journal);
    }
    if (!sameHead(before.head, after.head) || before.signature !== after.signature) await publish();
    if (origin) {
      const path = join(this.directory, 'operation-origin.json');
      if (operation.identity)
        await atomic(path, JSON.stringify({ ...origin, identity: operation.identity }));
      else await rm(path, { force: true });
    }
    await rm(pending, { force: true });
    if (failure) throw failure;
  }
  private async indexTree(indexFile: string, signal?: AbortSignal) {
    return oidSchema.parse(
      (await this.run(['write-tree'], { indexFile, signal, readOnly: false })).stdout
        .toString()
        .trim(),
    );
  }
  private async operationOrigin() {
    const path = join(this.directory, 'operation-origin.json');
    try {
      if ((await stat(path)).size > 128 * 1024 * 1024)
        throw new GitError(
          'UNDO_UNAVAILABLE',
          'The operation recovery record exceeds its size limit.',
        );
      const origin = operationOriginSchema.parse(JSON.parse(await readFile(path, 'utf8')));
      if (
        origin.identity &&
        origin.identity === (await inspectOperation(this.repo.gitDir)).identity
      )
        return origin;
      await rm(path, { force: true });
      return undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
  async operationAction(
    input: OperationAction,
    signal?: AbortSignal,
    onProgress?: (text: string) => void,
    edit?: GitEditor,
  ) {
    const options = operationActionSchema.parse(input);
    await this.locked(async (indexFile, publish) => {
      const state = await this.operationState(signal, indexFile);
      if (state.token !== options.token)
        throw new GitError(
          'STALE_OPERATION',
          'The operation or working files changed. Review the current state before continuing.',
        );
      if (!state.actions.includes(options.action))
        throw new GitError(
          'INVALID_OPERATION_ACTION',
          'This action is not available for the current Git operation.',
        );
      if (options.action === 'continue' && state.conflicts)
        throw new GitError(
          'UNRESOLVED_CONFLICTS',
          'Resolve and stage all conflicted files before continuing.',
        );
      await this.runOperation(
        [state.kind, `--${options.action}`],
        `${state.kind} ${options.action}`,
        indexFile,
        publish,
        signal,
        onProgress,
        await this.operationOrigin(),
        options.action === 'abort',
        undefined,
        edit,
      );
    }, signal);
    return this.state();
  }
  async pullContext(input: PullOptions, signal?: AbortSignal) {
    const options = pullOptionsSchema.parse(input);
    if (this.repo.isBare)
      throw new GitError('BARE_REPOSITORY', 'This repository has no working tree');
    await this.noOperation();
    const state = await this.state(signal);
    if (state.revision !== options.revision)
      throw new GitError(
        'STALE_PULL',
        'HEAD or staged files changed. Review the current branch before pulling.',
      );
    if (state.head.kind !== 'branch' || !state.head.oid)
      throw new GitError('PULL_BRANCH_REQUIRED', 'Switch to an existing branch before pulling.');
    if (state.status.entries.some((entry) => !['untracked', 'ignored'].includes(entry.kind)))
      throw new GitError('PULL_DIRTY', 'Commit or stash tracked changes before pulling.');
    const fields = (
      await this.run(
        ['for-each-ref', '--format=%(upstream)%00%(upstream:remotename)', state.head.ref],
        { signal },
      )
    ).stdout
      .toString()
      .trimEnd()
      .split('\0');
    if (!fields[0] || !fields[1])
      throw new GitError(
        'PULL_UPSTREAM_REQUIRED',
        'Set an upstream for this branch before pulling.',
      );
    return { head: state.head, upstream: fields[0], remote: fields[1] };
  }
  async integratePull(
    input: PullOptions,
    context: Awaited<ReturnType<WorkingTree['pullContext']>>,
    signal?: AbortSignal,
    onProgress?: (text: string) => void,
  ) {
    const options = pullOptionsSchema.parse(input);
    await this.locked(async (indexFile, publish) => {
      if (JSON.stringify(await this.pullContext(options, signal)) !== JSON.stringify(context))
        throw new GitError(
          'STALE_PULL',
          'The branch or upstream changed during fetch. Review it before pulling again.',
        );
      const target = oidSchema.parse(
        (
          await this.run(['rev-parse', '--verify', `${context.upstream}^{commit}`], { signal })
        ).stdout
          .toString()
          .trim(),
      );
      await this.runOperation(
        options.mode === 'rebase'
          ? [
              'rebase',
              '--merge',
              '--no-autostash',
              '--no-update-refs',
              '--no-rebase-merges',
              target,
            ]
          : [
              'merge',
              options.mode === 'ff-only' ? '--ff-only' : '--ff',
              '--no-autostash',
              '--no-edit',
              target,
            ],
        `Pull (${options.mode})`,
        indexFile,
        publish,
        signal,
        onProgress,
        true,
      );
    }, signal);
    return this.state();
  }
  stashes(signal?: AbortSignal) {
    return new StashStore((args, options) => this.run(args, options)).list(signal);
  }
  async stashAction(input: StashActionOptions, signal?: AbortSignal) {
    const options = stashActionOptionsSchema.parse(input);
    const store = new StashStore((args, options) => this.run(args, options));
    let warning: string | undefined;
    if (options.action === 'rename') warning = await store.rename(options, signal);
    else if (options.action === 'drop') await store.drop(options, signal);
    else {
      await this.locked(async (indexFile, publish) => {
        await this.noOperation();
        await store.selected(options, signal);
        const before = await this.saved(indexFile);
        const pending = join(this.directory, `pending-${randomUUID()}.json`);
        const record = { label: 'Apply stash', stash: options.oid, indexFile, before };
        await atomic(pending, JSON.stringify(record));
        let failure: unknown;
        try {
          await this.run(
            ['stash', 'apply', ...(options.restoreIndex ? ['--index'] : []), options.oid],
            { indexFile, signal, readOnly: false },
          );
        } catch (error) {
          failure = error;
        }
        const after = await this.saved(indexFile);
        await atomic(pending, JSON.stringify({ ...record, after }));
        if (!sameHead(before.head, after.head))
          throw new GitError(
            'CONCURRENT_HEAD',
            `HEAD changed while applying the stash. The index was not published. Recovery record: ${pending}`,
          );
        if (before.signature !== after.signature) await publish();
        await rm(pending, { force: true });
        if (failure) throw failure;
      }, signal);
      if (options.action === 'pop') {
        try {
          await store.drop(options, signal);
        } catch (error) {
          warning = `Stash applied but its saved entry was kept: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
    }
    return { state: await this.state(), stashes: await store.list(), warning };
  }
  async stashPush(input: StashPushOptions, signal?: AbortSignal) {
    const options = stashPushOptionsSchema.parse(input);
    await this.noOperation();
    const current = await this.state(signal);
    if (current.status.entries.some((entry) => entry.kind === 'conflict'))
      throw new GitError('UNRESOLVED_CONFLICT', 'Resolve conflicts before stashing');
    const selected =
      options.paths ??
      current.status.entries
        .filter(
          (entry) =>
            (options.includeUntracked || entry.kind !== 'untracked') &&
            (!options.stagedOnly || entry.index !== '.'),
        )
        .map((entry) => entry.pathBytes);
    if (!selected.length)
      throw new GitError('NOTHING_TO_STASH', 'There are no matching changes to stash');
    if (options.stagedOnly && options.paths) {
      const staged = current.status.entries
        .filter((entry) => entry.kind !== 'untracked' && entry.index !== '.')
        .map((entry) => entry.pathBytes);
      if (
        staged.some((path) => !selected.includes(path)) ||
        selected.some((path) => !staged.includes(path))
      )
        throw new GitError(
          'STAGED_STASH_SELECTION',
          'Staged-only stashes include all staged files. Use a regular stash for a path selection.',
        );
    }
    const stdin = await this.paths(selected, signal);
    const entries = current.status.entries.filter((entry) => selected.includes(entry.pathBytes));
    if (entries.some((entry) => entry.kind === 'untracked') && !options.includeUntracked)
      throw new GitError('UNTRACKED_SELECTION', 'Enable untracked files to stash this selection');
    if (entries.some((entry) => entry.submodule.startsWith('S')))
      throw new GitError('SUBMODULE_OPERATION', 'Stash changes inside each submodule separately');
    const paths = [
      ...new Set(
        entries.flatMap((entry) => [
          entry.pathBytes,
          ...(entry.origPathBytes ? [entry.origPathBytes] : []),
        ]),
      ),
    ];
    return this.transaction(
      'Stash changes (keep stash on Undo)',
      async (indexFile, before) => {
        if (this.revision(before) !== options.revision)
          throw new GitError(
            'STALE_STASH',
            'HEAD or staged content changed. Review the stash again.',
          );
        await this.noOperation();
        await this.backups.assertCurrent(before.files!, 'STALE_STASH');
        if (!before.head.oid)
          throw new GitError('UNBORN_STASH', 'Create an initial commit before stashing');
        const push = () =>
          this.run(
            [
              'stash',
              'push',
              ...(options.includeUntracked ? ['--include-untracked'] : []),
              ...(options.stagedOnly ? ['--staged'] : []),
              ...(options.message ? ['--message', options.message] : []),
              ...(options.stagedOnly ? [] : ['--pathspec-from-file=-', '--pathspec-file-nul']),
            ],
            { indexFile, stdin: options.stagedOnly ? undefined : stdin, signal, readOnly: false },
          );
        if (options.stagedOnly) await push();
        else await this.withStashSelection(indexFile, before, paths, push, signal);
      },
      signal,
      paths,
    );
  }
  private async withStashSelection(
    indexFile: string,
    before: Saved,
    paths: string[],
    change: () => Promise<unknown>,
    signal?: AbortSignal,
  ) {
    const selected = new Set(paths);
    const entries = async (signal?: AbortSignal) => {
      const raw = (await this.run(['ls-files', '--stage', '-z'], { indexFile, signal })).stdout;
      const parts: Buffer[] = [];
      for (let at = 0; at < raw.length;) {
        const end = raw.indexOf(0, at),
          tab = raw.indexOf(9, at);
        if (end < 0 || tab < at || tab > end)
          throw new GitError('INVALID_INDEX', 'Invalid index entry');
        if (selected.has(raw.subarray(tab + 1, end).toString('base64')))
          parts.push(raw.subarray(at, end + 1));
        at = end + 1;
      }
      return Buffer.concat(parts);
    };
    const replace = (raw: Buffer, signal?: AbortSignal) =>
      this.run(['update-index', '-z', '--index-info'], {
        indexFile,
        signal,
        readOnly: false,
        stdin: Buffer.concat([
          ...paths.map((path) =>
            Buffer.concat([
              Buffer.from(`0 ${'0'.repeat(before.head.oid!.length)}\t`),
              Buffer.from(path, 'base64'),
              Buffer.from([0]),
            ]),
          ),
          raw,
        ]),
      });
    const original = await entries(signal);
    const originalTime = await stat(indexFile);
    let prepared = false;
    try {
      await this.run(['read-tree', before.head.oid!], { indexFile, signal, readOnly: false });
      await replace(original, signal);
      prepared = true;
      await change();
    } finally {
      let after: Buffer | undefined;
      try {
        if (prepared) after = await entries();
      } finally {
        await writeFile(indexFile, Buffer.from(before.index, 'base64'));
        await utimes(
          indexFile,
          originalTime.atime,
          new Date(Math.floor(originalTime.mtimeMs / 1000) * 1000),
        );
      }
      if (after) await replace(after);
    }
  }
  async files(action: 'stage' | 'unstage', selected: string[], signal?: AbortSignal) {
    const stdin = await this.paths(selected, signal);
    return this.transaction(
      action === 'stage' ? 'Stage files' : 'Unstage files',
      async (indexFile) => {
        const head = await this.head(signal);
        const args =
          action === 'stage'
            ? ['add', '-A']
            : head.oid
              ? ['restore', '--staged']
              : ['rm', '--cached', '--force', '--ignore-unmatch'];
        await this.run([...args, '--pathspec-from-file=-', '--pathspec-file-nul'], {
          indexFile,
          stdin,
          readOnly: false,
          signal,
        });
      },
      signal,
    );
  }
  private async editorContext(input: WorkingFileOptions, signal?: AbortSignal, indexFile?: string) {
    const options = workingFileOptionsSchema.parse(input);
    await this.noOperation();
    await this.paths([options.pathBytes], signal);
    return readWorkingFile(
      this.backups,
      (args, settings) => this.run(args, { ...settings, indexFile }),
      options.pathBytes,
      this.revision(await this.fingerprint(indexFile)),
      signal,
    );
  }
  async workingFile(options: WorkingFileOptions, signal?: AbortSignal) {
    return (await this.editorContext(options, signal)).preview;
  }
  async saveWorkingFile(input: SaveWorkingFile, signal?: AbortSignal) {
    const options = saveWorkingFileSchema.parse(input);
    return this.transaction(
      'Save working file',
      async (indexFile) => {
        const current = await this.editorContext(
          { pathBytes: options.pathBytes },
          signal,
          indexFile,
        );
        if (current.preview.token !== options.token)
          throw new GitError(
            'STALE_FILE',
            'The file or Git state changed. Reload it before saving; newer edits were left untouched.',
          );
        const bytes = encodeWorkingFile(options.text, current.preview);
        await this.backups.assertCurrent([current.image], 'STALE_FILE');
        await this.backups.write(options.pathBytes, bytes, current.image.mode!, signal);
      },
      signal,
      [options.pathBytes],
    );
  }
  async workingComparison(options: WorkingComparisonOptions, signal?: AbortSignal) {
    await this.paths([options.pathBytes], signal);
    const state = await this.state(signal),
      before = await this.fingerprint();
    const entry = state.status.entries.find((entry) => entry.pathBytes === options.pathBytes);
    if (!entry)
      throw new GitError('STALE_STATUS', 'Refresh the working tree before comparing this file');
    let temporary: string | undefined;
    try {
      if (entry.kind === 'untracked' && options.side === 'worktree') {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        temporary = join(this.directory, `comparison-${randomUUID()}`);
        try {
          await copyIndex(join(this.repo.gitDir, 'index'), temporary);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          await this.run(['read-tree', '--empty'], {
            indexFile: temporary,
            readOnly: false,
            signal,
          });
        }
        await this.run(
          ['add', '--intent-to-add', '--pathspec-from-file=-', '--pathspec-file-nul'],
          {
            indexFile: temporary,
            readOnly: false,
            signal,
            stdin: Buffer.concat([Buffer.from(options.pathBytes, 'base64'), Buffer.from([0])]),
          },
        );
      }
      const result = await workingComparison(
        (args, settings) => this.run(args, { ...settings, indexFile: temporary }),
        this.backups,
        options,
        entry,
        before.head.oid,
        signal,
      );
      if (this.revision(before) !== this.revision(await this.fingerprint()))
        throw new GitError('FILE_CHANGED', 'Git state changed while reading this comparison');
      return result;
    } finally {
      if (temporary) {
        await rm(temporary, { force: true });
        await rm(`${temporary}.lock`, { force: true });
      }
    }
  }
  async diff(
    pathBytes: string,
    side: 'worktree' | 'index',
    signal?: AbortSignal,
    sourceIndex?: string,
  ): Promise<WorkingDiff> {
    const stdin = await this.paths([pathBytes], signal);
    const bytes = Buffer.from(pathBytes, 'base64'),
      path = bytes.toString('utf8');
    const state = await this.state(signal),
      entry = state.status.entries.find((e) => e.pathBytes === pathBytes)!;
    const unsupported = (reason: string): WorkingDiff => ({
      ...parsePatch('', path),
      pathBytes,
      side,
      token: hash(reason + pathBytes + side),
      partialReason: reason,
    });
    if (!Buffer.from(path).equals(bytes))
      return unsupported('Use whole-file controls for filenames that are not UTF-8');
    if (entry.kind === 'rename' || entry.kind === 'conflict')
      return unsupported('Use whole-file controls for renames and unresolved conflicts');
    let temporary: string | undefined,
      indexFile = sourceIndex;
    try {
      if (entry.kind === 'untracked' && side === 'worktree') {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        temporary = join(this.directory, `preview-${randomUUID()}`);
        indexFile = temporary;
        try {
          await copyIndex(sourceIndex ?? join(this.repo.gitDir, 'index'), temporary);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          await this.run(['read-tree', '--empty'], { indexFile, readOnly: false, signal });
        }
        await this.run(
          ['add', '--intent-to-add', '--pathspec-from-file=-', '--pathspec-file-nul'],
          { indexFile, stdin, readOnly: false, signal },
        );
      }
      const output = (
        await this.run(
          [
            'diff',
            ...(side === 'index' ? ['--cached'] : []),
            '--no-ext-diff',
            '--no-textconv',
            '--no-renames',
            '--no-color',
            '--src-prefix=a/',
            '--dst-prefix=b/',
            '--unified=3',
            '--',
            path,
          ],
          { indexFile, signal, maxBytes: 2 * 1024 * 1024 },
        )
      ).stdout;
      const raw = output.toString('utf8');
      if (!Buffer.from(raw).equals(output))
        return unsupported('Non-UTF-8 diff content requires whole-file controls');
      if (raw.split('\n').length > 10000)
        return unsupported('Diff exceeds 10,000 lines; use whole-file controls');
      const file = parsePatch(raw, path);
      const partialReason = file.binary
        ? 'Binary content requires whole-file controls'
        : !/^100(?:644|755)$/.test(side === 'index' ? file.newMode : file.oldMode)
          ? 'Links and type changes require whole-file controls'
          : !file.hunks.length
            ? 'No selectable text changes; use whole-file controls for mode-only changes'
            : undefined;
      return { ...file, pathBytes, side, token: hash(raw + pathBytes + side), partialReason };
    } catch (error) {
      if (error instanceof GitError && error.code === 'OUTPUT_LIMIT')
        return unsupported('Diff exceeds 2 MiB; use whole-file controls');
      throw error;
    } finally {
      if (temporary) {
        await rm(temporary, { force: true });
        await rm(`${temporary}.lock`, { force: true });
      }
    }
  }
  async patch(options: PatchOptions, signal?: AbortSignal) {
    return this.transaction(
      options.side === 'index' ? 'Unstage lines' : 'Stage lines',
      async (indexFile) => {
        const diff = await this.diff(options.pathBytes, options.side, signal, indexFile);
        if (diff.token !== options.token)
          throw new GitError(
            'STALE_DIFF',
            'The file changed since this preview. Reopen it before selecting lines.',
          );
        if (diff.partialReason) throw new GitError('PARTIAL_UNSUPPORTED', diff.partialReason);
        const patch = selectPatch(diff, options.lines, options.side === 'index');
        await this.run(
          ['apply', '--cached', '--recount', '--unidiff-zero', '--whitespace=nowarn', '-'],
          { indexFile, stdin: patch, signal, readOnly: false },
        );
      },
      signal,
    );
  }
  private async pruneFiles(journal: Journal) {
    await this.backups
      .prune(
        [...journal.undo, ...journal.redo].flatMap((entry) => [
          ...(entry.before.files ?? []),
          ...(entry.after.files ?? []),
        ]),
      )
      .catch(() => {});
  }
  private discardToken(value: {
    head: Repository['head'];
    signature: string;
    files?: FileImage[];
  }) {
    return hash(JSON.stringify({ revision: this.revision(value), files: value.files }));
  }
  async discardPreview(paths: string[], signal?: AbortSignal) {
    await this.paths(paths, signal);
    const fingerprint = await this.fingerprint();
    const files = await this.backups.capture(paths, false, signal);
    return {
      token: this.discardToken({ ...fingerprint, files }),
      paths: files.map((f) => Buffer.from(f.pathBytes, 'base64').toString('utf8')),
      bytes: files.reduce((n, f) => n + (f.bytes ?? 0), 0),
    };
  }
  async discard(paths: string[], token: string, signal?: AbortSignal) {
    await this.paths(paths, signal);
    return this.transaction(
      'Discard files',
      async (indexFile, before) => {
        if (token !== this.discardToken(before))
          throw new GitError(
            'STALE_DISCARD',
            'Files or staged content changed since confirmation. Review them again before discarding.',
          );
        const raw = (await this.run(['ls-files', '--stage', '-z'], { indexFile, signal })).stdout;
        const tracked = new Map<string, { mode: string; oid: string }>();
        for (let at = 0; at < raw.length;) {
          const end = raw.indexOf(0, at),
            tab = raw.indexOf(9, at);
          if (end < 0 || tab < 0 || tab > end) break;
          const [mode, oid, stage] = raw.subarray(at, tab).toString().split(' ');
          const pathBytes = raw.subarray(tab + 1, end).toString('base64');
          if (stage !== '0' && paths.includes(pathBytes))
            throw new GitError(
              'UNRESOLVED_CONFLICT',
              'Resolve the conflict before discarding this file',
            );
          tracked.set(pathBytes, { mode: mode!, oid: oid! });
          at = end + 1;
        }
        const restoring = before.files!.filter((f) => tracked.has(f.pathBytes));
        if (restoring.some((f) => tracked.get(f.pathBytes)!.mode === '160000'))
          throw new GitError(
            'SUBMODULE_OPERATION',
            'Use submodule controls to change a submodule worktree',
          );
        if (restoring.length) {
          const sizes = (
            await this.run(['cat-file', '--batch-check=%(objectsize)'], {
              stdin: restoring.map((f) => tracked.get(f.pathBytes)!.oid).join('\n') + '\n',
              signal,
            })
          ).stdout
            .toString()
            .trim()
            .split('\n')
            .map(Number);
          if (
            sizes.some((n) => !Number.isFinite(n) || n > 64 * 1024 * 1024) ||
            sizes.reduce((n, s) => n + s, 0) > 128 * 1024 * 1024
          )
            throw new GitError('UNDO_LIMIT', 'Restored content exceeds discard backup limits');
        }
        await this.backups.assertCurrent(before.files!, 'STALE_DISCARD');
        for (const file of before.files!)
          if (!tracked.has(file.pathBytes)) await this.backups.trash(file, signal);
        if (restoring.length)
          await this.run(
            ['restore', '--worktree', '--pathspec-from-file=-', '--pathspec-file-nul'],
            {
              indexFile,
              signal,
              readOnly: false,
              stdin: Buffer.concat(
                restoring.flatMap((f) => [Buffer.from(f.pathBytes, 'base64'), Buffer.from([0])]),
              ),
            },
          );
      },
      signal,
      paths,
    );
  }
  private async referenceState(names: string[], signal?: AbortSignal) {
    const state: Record<string, string | null> = Object.fromEntries(
      names.map((name) => [name, null]),
    );
    const output = await this.run(
      ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(symref)', '--', ...names],
      { signal },
    );
    for (const line of output.stdout.toString().split('\n')) {
      const [name, oid, symbolic] = line.split('\0');
      if (!name || !names.includes(name)) continue;
      if (symbolic)
        throw new GitError('SYMBOLIC_REF', 'This action requires a direct branch or tag');
      state[name] = oid!;
    }
    return state;
  }
  private async restoreReferences(
    target: Record<string, string | null>,
    expected: Record<string, string | null>,
    signal?: AbortSignal,
  ) {
    const changed = Object.entries(target).filter(([name, oid]) => oid !== expected[name]);
    if (changed.some(([name]) => name.startsWith('refs/heads/'))) {
      const worktrees = (
        await this.run(['worktree', 'list', '--porcelain', '-z'], { signal })
      ).stdout
        .toString()
        .split('\0');
      if (changed.some(([name]) => worktrees.includes(`branch ${name}`)))
        throw new GitError(
          'BRANCH_IN_USE',
          'A worktree is using this branch. Switch that worktree before undoing this action.',
        );
    }
    const commands = changed.map(([name, oid]) =>
      oid
        ? `update ${name} ${oid} ${expected[name] ?? '0'.repeat(oid.length)}`
        : `delete ${name} ${expected[name]}`,
    );
    if (commands.length)
      await this.run(['update-ref', '--no-deref', '--stdin'], {
        stdin: ['start', ...commands, 'prepare', 'commit', ''].join('\n'),
        readOnly: false,
        signal,
      });
  }
  private branchConfiguration(names: string[], signal?: AbortSignal) {
    return this.configuration.read(names, signal);
  }
  private async deleteBranch(
    options: Extract<ReferenceOptions, { action: 'deleteBranch' }>,
    signal?: AbortSignal,
  ) {
    const ref = `refs/heads/${options.name}`;
    if (
      options.name.startsWith('-') ||
      (await this.run(['check-ref-format', ref], { signal, allowedExitCodes: [0, 1] })).exitCode !==
        0
    )
      throw new GitError('INVALID_REF', 'Enter a valid branch name');
    return this.transaction(
      'Delete branch',
      async (_index, before) => {
        if (before.refs?.[ref] !== options.expected)
          throw new GitError(
            'STALE_REF',
            'The branch changed. Review its current target before deleting.',
          );
        const worktrees = (
          await this.run(['worktree', 'list', '--porcelain', '-z'], { signal })
        ).stdout
          .toString()
          .split('\0');
        if (
          (before.head.kind === 'branch' && before.head.ref === ref) ||
          worktrees.includes(`branch ${ref}`)
        )
          throw new GitError(
            'BRANCH_IN_USE',
            'Switch away from this branch in every worktree before deleting it',
          );
        if (!options.force) {
          const upstream = (
            await this.run(['rev-parse', '--verify', '--quiet', `${ref}@{upstream}`], {
              signal,
              allowedExitCodes: [0, 1, 128],
            })
          ).stdout
            .toString()
            .trim();
          const into = upstream || before.head.oid;
          if (
            !into ||
            (
              await this.run(['merge-base', '--is-ancestor', options.expected, into], {
                signal,
                allowedExitCodes: [0, 1],
              })
            ).exitCode !== 0
          )
            throw new GitError(
              'UNMERGED_BRANCH',
              'This branch has unmerged commits. Review the target and explicitly allow deleting unmerged work to continue.',
            );
        }
        await this.configuration.restore(
          { [options.name]: [] },
          before.branchConfig!,
          async () => {
            await this.run(['update-ref', '--no-deref', '-d', ref, options.expected], {
              signal,
              readOnly: false,
            });
          },
          signal,
        );
      },
      signal,
      undefined,
      false,
      [ref],
      [options.name],
    );
  }
  private async setUpstream(
    options: Extract<ReferenceOptions, { action: 'setUpstream' }>,
    signal?: AbortSignal,
  ) {
    const ref = `refs/heads/${options.name}`;
    if (
      options.name.startsWith('-') ||
      (await this.run(['check-ref-format', ref], { signal, allowedExitCodes: [0, 1] })).exitCode !==
        0
    )
      throw new GitError('INVALID_REF', 'Enter a valid branch name');
    if (
      options.upstream &&
      (!/^refs\/(heads|remotes)\//.test(options.upstream) ||
        (
          await this.run(['check-ref-format', options.upstream], {
            signal,
            allowedExitCodes: [0, 1],
          })
        ).exitCode !== 0)
    )
      throw new GitError('INVALID_REF', 'Choose an existing local or remote branch as upstream');
    return this.transaction(
      'Set upstream',
      async (_index, before) => {
        if (before.refs?.[ref] !== options.expected)
          throw new GitError(
            'STALE_REF',
            'The branch changed. Review it before setting its upstream.',
          );
        await this.run(
          [
            'branch',
            ...(options.upstream
              ? [`--set-upstream-to=${options.upstream}`]
              : ['--unset-upstream']),
            '--',
            options.name,
          ],
          { signal, readOnly: false },
        );
      },
      signal,
      undefined,
      false,
      [ref],
      [options.name],
    );
  }
  private async canRename(ref: string, signal?: AbortSignal) {
    const current = await this.head(signal);
    const fields = (await this.run(['worktree', 'list', '--porcelain', '-z'], { signal })).stdout
      .toString()
      .split('\0');
    const using = fields.filter((field) => field === `branch ${ref}`).length;
    if (using > (current.kind === 'branch' && current.ref === ref ? 1 : 0))
      throw new GitError('BRANCH_IN_USE', 'Switch the other worktree before renaming this branch');
  }
  private async renameBranch(
    options: Extract<ReferenceOptions, { action: 'renameBranch' }>,
    signal?: AbortSignal,
  ) {
    const names = [options.name, options.newName];
    for (const name of names)
      if (
        name.startsWith('-') ||
        name === 'HEAD' ||
        (
          await this.run(['check-ref-format', `refs/heads/${name}`], {
            signal,
            allowedExitCodes: [0, 1],
          })
        ).exitCode !== 0
      )
        throw new GitError('INVALID_REF', 'Enter a valid branch name');
    const refs = names.map((name) => `refs/heads/${name}`);
    return this.transaction(
      'Rename branch',
      async (_index, before) => {
        await this.noOperation();
        if (before.refs?.[refs[0]!] !== options.expected)
          throw new GitError(
            'STALE_REF',
            'The branch changed. Review its current target before renaming.',
          );
        if (before.refs?.[refs[1]!] || before.branchConfig?.[options.newName]?.length)
          throw new GitError(
            'REF_EXISTS',
            'The new name already has a branch or saved branch settings',
          );
        await this.canRename(refs[0]!, signal);
        await this.run(['branch', '--move', '--', options.name, options.newName], {
          signal,
          readOnly: false,
        });
      },
      signal,
      undefined,
      true,
      refs,
      names,
    );
  }
  private async restoreRename(target: Saved, expected: Saved, signal?: AbortSignal) {
    const from = Object.keys(expected.refs ?? {}).find(
      (name) => expected.refs![name] && !target.refs?.[name],
    );
    const to = Object.keys(target.refs ?? {}).find(
      (name) => target.refs![name] && !expected.refs?.[name],
    );
    if (
      !from?.startsWith('refs/heads/') ||
      !to?.startsWith('refs/heads/') ||
      expected.refs![from] !== target.refs![to]
    )
      throw new GitError('UNDO_UNAVAILABLE', 'The branch rename record is incomplete');
    await this.noOperation();
    await this.canRename(from, signal);
    const pending = join(this.directory, `pending-${randomUUID()}.json`);
    await atomic(
      pending,
      JSON.stringify({ label: 'Restore branch rename', before: expected, target }),
    );
    await this.run(['branch', '--move', '--', from.slice(11), to.slice(11)], {
      signal,
      readOnly: false,
    });
    if (
      !sameHead(await this.head(), target.head) ||
      JSON.stringify(await this.referenceState(Object.keys(target.refs!))) !==
        JSON.stringify(target.refs) ||
      JSON.stringify(await this.branchConfiguration(Object.keys(target.branchConfig!))) !==
        JSON.stringify(target.branchConfig)
    )
      throw new GitError(
        'RENAME_CHANGED',
        `Another writer changed the rename result. Recovery backup: ${pending}`,
      );
    return pending;
  }
  private async noOperation() {
    const markers = await readdir(this.repo.gitDir);
    if (
      markers.some((p) =>
        [
          'MERGE_HEAD',
          'CHERRY_PICK_HEAD',
          'REVERT_HEAD',
          'rebase-merge',
          'rebase-apply',
          'sequencer',
          'BISECT_LOG',
        ].includes(p),
      )
    )
      throw new GitError(
        'OPERATION_IN_PROGRESS',
        'Finish or abort the active Git operation before starting another action',
      );
  }
  private async checkoutBranch(
    options: Extract<ReferenceOptions, { action: 'checkoutBranch' }>,
    signal?: AbortSignal,
  ) {
    const ref = `refs/heads/${options.name}`;
    if (
      options.name.startsWith('-') ||
      (await this.run(['check-ref-format', ref], { signal, allowedExitCodes: [0, 1] })).exitCode !==
        0
    )
      throw new GitError('INVALID_REF', 'Enter a valid branch name');
    return this.transaction(
      'Switch branch',
      async (indexFile) => {
        await this.noOperation();
        if ((await this.referenceState([ref], signal))[ref] !== options.expected)
          throw new GitError(
            'STALE_REF',
            'The branch changed. Review its current target before switching.',
          );
        await this.run(['switch', '--no-guess', '--', options.name], {
          indexFile,
          signal,
          readOnly: false,
        });
      },
      signal,
      undefined,
      true,
    );
  }
  private async restoreCheckout(
    indexFile: string,
    publish: () => Promise<void>,
    target: Saved,
    expected: Saved,
    signal?: AbortSignal,
  ) {
    await this.noOperation();
    if (
      target.head.kind === 'branch' &&
      (await this.referenceState([target.head.ref], signal))[target.head.ref] !==
        (target.head.oid ?? null)
    )
      throw new GitError(
        'STALE_UNDO',
        'The previous branch moved. Undo would switch to a different commit.',
      );
    if (target.head.oid)
      await this.run(['cat-file', '-e', `${target.head.oid}^{commit}`], { signal });
    const pending = join(this.directory, `pending-${randomUUID()}.json`);
    await atomic(pending, JSON.stringify({ label: 'Restore checkout', before: expected, target }));
    let failure: unknown;
    try {
      const args =
        target.head.kind === 'branch'
          ? target.head.oid
            ? ['switch', '--no-guess', '--', target.head.ref.slice('refs/heads/'.length)]
            : ['switch', '--orphan', target.head.ref.slice('refs/heads/'.length)]
          : ['switch', '--detach', target.head.oid];
      await this.run(args, { indexFile, signal, readOnly: false });
    } catch (e) {
      failure = e;
    }
    const after = await this.saved(indexFile);
    const changed = !sameHead(after.head, expected.head) || after.signature !== expected.signature;
    if (changed) await publish();
    if (failure) {
      if (!changed) await rm(pending, { force: true });
      throw failure;
    }
    if (!sameHead(after.head, target.head) || after.signature !== target.signature)
      throw new GitError(
        'CHECKOUT_CHANGED',
        `Checkout hooks or another writer changed the result. Recovery backup: ${pending}`,
      );
    return pending;
  }
  async reference(input: ReferenceOptions, signal?: AbortSignal) {
    const options = referenceOptionsSchema.parse(input);
    if (options.action === 'checkoutBranch') return this.checkoutBranch(options, signal);
    if (options.action === 'renameBranch') return this.renameBranch(options, signal);
    if (options.action === 'setUpstream') return this.setUpstream(options, signal);
    if (options.action === 'deleteBranch') return this.deleteBranch(options, signal);
    const branch = options.action === 'createBranch';
    const ref = `refs/${branch ? 'heads' : 'tags'}/${options.name}`;
    if (options.name.startsWith('-') || options.name === 'HEAD' || options.name.includes('\0'))
      throw new GitError('INVALID_REF', 'Enter a valid branch or tag name');
    const valid = await this.run(['check-ref-format', ref], { signal, allowedExitCodes: [0, 1] });
    if (valid.exitCode !== 0) throw new GitError('INVALID_REF', 'Enter a valid branch or tag name');
    return this.transaction(
      options.action === 'createBranch'
        ? 'Create branch'
        : options.action === 'createTag'
          ? 'Create tag'
          : 'Delete tag',
      async (_index, before) => {
        if (options.action === 'deleteTag') {
          if (before.refs?.[ref] !== options.expected)
            throw new GitError(
              'STALE_REF',
              'The tag changed. Review its current target before deleting.',
            );
          await this.run(['update-ref', '--no-deref', '-d', ref, options.expected], {
            signal,
            readOnly: false,
          });
          return;
        }
        if (before.refs?.[ref])
          throw new GitError('REF_EXISTS', 'A reference with that name already exists');
        await this.run(['cat-file', '-e', `${options.target}^{commit}`], { signal });
        if (branch)
          await this.run(['branch', '--no-track', '--', options.name, options.target], {
            signal,
            readOnly: false,
          });
        else {
          if (options.sign && !options.message?.trim())
            throw new GitError('INVALID_MESSAGE', 'A signed tag needs an annotation');
          if (
            options.message !== undefined &&
            (!options.message.trim() ||
              options.message.includes('\0') ||
              Buffer.byteLength(options.message) > 65536)
          )
            throw new GitError('INVALID_MESSAGE', 'Enter a tag annotation of at most 64 KiB');
          await this.run(
            [
              'tag',
              ...(options.message !== undefined
                ? ['--annotate', '--cleanup=verbatim', '--file=-']
                : []),
              options.sign ? '--sign' : '--no-sign',
              '--',
              options.name,
              options.target,
            ],
            { signal, readOnly: false, stdin: options.message, timeoutMs: 120000 },
          );
        }
      },
      signal,
      undefined,
      false,
      [ref],
    );
  }
  async commit(
    options: { message: string; revision: string; amend?: boolean; sign?: boolean },
    signal?: AbortSignal,
  ) {
    if (
      !options.message.trim() ||
      options.message.includes('\0') ||
      Buffer.byteLength(options.message) > 65536
    )
      throw new GitError('INVALID_MESSAGE', 'Enter a commit message of at most 64 KiB');
    return this.transaction(
      options.amend ? 'Amend commit' : 'Commit',
      async (indexFile, before) => {
        if (options.revision !== this.revision(before))
          throw new GitError(
            'STALE_COMMIT',
            'HEAD or staged content changed. Review the refreshed staged files before committing.',
          );
        if (options.amend && !before.head.oid)
          throw new GitError('UNBORN_HEAD', 'There is no commit to amend');
        const markers = await readdir(this.repo.gitDir);
        const operation = await this.operationState(signal, indexFile);
        const editingRebase =
          options.amend &&
          operation.kind === 'rebase' &&
          operation.editStopped &&
          !operation.conflicts &&
          before.head.kind === 'detached';
        if (
          !editingRebase &&
          markers.some((p) =>
            [
              'MERGE_HEAD',
              'CHERRY_PICK_HEAD',
              'REVERT_HEAD',
              'rebase-merge',
              'rebase-apply',
            ].includes(p),
          )
        )
          throw new GitError(
            'OPERATION_IN_PROGRESS',
            'Finish the active Git operation before committing here',
          );
        await this.run(
          [
            'commit',
            '--file=-',
            '--cleanup=verbatim',
            ...(options.amend ? ['--amend'] : []),
            ...(options.sign === true
              ? ['--gpg-sign']
              : options.sign === false
                ? ['--no-gpg-sign']
                : []),
          ],
          { indexFile, stdin: options.message, readOnly: false, signal, timeoutMs: 120000 },
        );
      },
      signal,
      undefined,
      true,
    );
  }
  private async verifyIndex(indexFile: string) {
    const entries = (
      await this.run(['ls-files', '--stage', '-z'], { indexFile })
    ).stdout.toString();
    const ids = [
      ...new Set(
        entries
          .split('\0')
          .filter((line) => line && !line.startsWith('160000 '))
          .map((line) => line.split(' ')[1]!)
          .filter((id) => !/^0+$/.test(id)),
      ),
    ];
    if (!ids.length) return;
    const checked = await this.run(['cat-file', '--batch-check=%(objectname) %(objecttype)'], {
      stdin: ids.join('\n') + '\n',
    });
    if (
      checked.stdout
        .toString()
        .split('\n')
        .some((line) => line.endsWith(' missing'))
    )
      throw new GitError(
        'UNDO_OBJECT_MISSING',
        'Git has removed objects required by this undo entry. Current work was left unchanged.',
      );
  }
  private async restoreIntegration(
    index: string,
    publish: () => Promise<void>,
    target: Saved,
    expected: Saved,
    fromTree: string,
    toTree: string,
    signal?: AbortSignal,
  ) {
    await this.noOperation();
    if (
      !target.head.oid ||
      !expected.head.oid ||
      target.head.kind !== expected.head.kind ||
      (target.head.kind === 'branch' &&
        (expected.head.kind !== 'branch' || target.head.ref !== expected.head.ref))
    )
      throw new GitError(
        'UNDO_UNSUPPORTED',
        'The integration changed branches unexpectedly. Restore the branch with Git before using Undo.',
      );
    const flags = new NulDecoder((entry) => {
      const flag = entry.subarray(0, 1).toString();
      if (flag === 'S' || /[a-z]/.test(flag))
        throw new GitError(
          'UNDO_UNSUPPORTED',
          'Integration Undo requires clearing skip-worktree and assume-unchanged flags first.',
        );
    });
    await this.run(['ls-files', '-v', '-z'], {
      indexFile: index,
      signal,
      onStdout: (chunk) => flags.push(chunk),
    });
    flags.finish();
    const verificationIndex = join(this.directory, `verify-${randomUUID()}.index`);
    try {
      for (const [saved, tree] of [
        [expected, fromTree],
        [target, toTree],
      ] as const) {
        await writeFile(verificationIndex, Buffer.from(saved.index, 'base64'));
        await this.verifyIndex(verificationIndex);
        // Rebuild pruned tree objects from the saved index only after checking its blobs.
        if ((await this.indexTree(verificationIndex, signal)) !== tree)
          throw new GitError(
            'UNDO_CHANGED',
            'The saved integration tree no longer matches its index.',
          );
      }
    } finally {
      await rm(verificationIndex, { force: true });
      await rm(`${verificationIndex}.lock`, { force: true });
    }
    const args = ['read-tree', '-m', '-u', '--no-recurse-submodules', fromTree, toTree];
    try {
      await this.run([...args.slice(0, 1), '--dry-run', ...args.slice(1)], {
        indexFile: index,
        signal,
      });
    } catch (error) {
      if (!(error instanceof GitError) || error.code !== 'GIT_FAILED') throw error;
      throw new GitError(
        'STALE_UNDO',
        'Working files would be overwritten by this Undo. Commit or stash newer edits first.',
      );
    }
    const pending = join(this.directory, `pending-${randomUUID()}.json`);
    await atomic(
      pending,
      JSON.stringify({ label: 'Restore integration', before: expected, target, fromTree, toTree }),
    );
    let movedHead = false;
    try {
      await this.run(args, { indexFile: index, signal, readOnly: false });
      if (!sameHead(await this.head(), expected.head))
        throw new GitError('STALE_UNDO', 'HEAD changed while restoring the tree.');
      if (!sameHead(target.head, expected.head)) {
        const ref = expected.head.kind === 'branch' ? expected.head.ref : 'HEAD';
        await this.run(['update-ref', '--no-deref', ref, target.head.oid!, expected.head.oid!], {
          signal,
          readOnly: false,
        });
        movedHead = true;
      }
      const actual = await this.saved(index);
      if (!sameHead(actual.head, target.head) || actual.signature !== target.signature)
        throw new GitError(
          'UNDO_CHANGED',
          `The integration result changed unexpectedly. Recovery record: ${pending}`,
        );
      await publish();
      return pending;
    } catch (error) {
      if (!movedHead) {
        // Native two-tree checks also protect edits made during this rollback.
        await this.run(['read-tree', '-m', '-u', '--no-recurse-submodules', toTree, fromTree], {
          indexFile: index,
          readOnly: false,
        }).catch(() => {});
      }
      throw error;
    }
  }
  async undo(redo = false, signal?: AbortSignal) {
    await this.locked(
      async (index, publish) => {
        const journal = await this.journal(),
          source = redo ? journal.redo : journal.undo;
        const entry = source.at(-1);
        if (!entry) throw new GitError('NOTHING_TO_UNDO', `Nothing to ${redo ? 'redo' : 'undo'}`);
        const expected = redo ? entry.before : entry.after,
          target = redo ? entry.after : entry.before;
        const current = await this.saved(index);
        if (!sameHead(current.head, expected.head) || current.signature !== expected.signature)
          throw new GitError(
            'STALE_UNDO',
            'HEAD or the index changed outside this action. Undo would overwrite newer work.',
          );
        if (expected.files) await this.backups.assertCurrent(expected.files);
        if (
          expected.refs &&
          JSON.stringify(await this.referenceState(Object.keys(expected.refs))) !==
            JSON.stringify(expected.refs)
        )
          throw new GitError(
            'STALE_UNDO',
            'A reference changed outside this action. Newer work was left unchanged.',
          );
        if (
          expected.branchConfig &&
          JSON.stringify(
            await this.branchConfiguration(Object.keys(expected.branchConfig), signal),
          ) !== JSON.stringify(expected.branchConfig)
        )
          throw new GitError(
            'STALE_UNDO',
            'Branch settings changed outside this action. Newer settings were left unchanged.',
          );
        if (entry.trees) {
          const pending = await this.restoreIntegration(
            index,
            publish,
            target,
            expected,
            redo ? entry.trees.before : entry.trees.after,
            redo ? entry.trees.after : entry.trees.before,
            signal,
          );
          source.pop();
          (redo ? journal.undo : journal.redo).push(entry);
          await this.saveJournal(journal);
          await rm(pending, { force: true });
          return;
        }
        if (entry.label === 'Rename branch') {
          const pending = await this.restoreRename(target, expected, signal);
          source.pop();
          (redo ? journal.undo : journal.redo).push(entry);
          await this.saveJournal(journal);
          await rm(pending, { force: true });
          return;
        }
        const switching =
          target.head.kind !== expected.head.kind ||
          (target.head.kind === 'branch' &&
            expected.head.kind === 'branch' &&
            target.head.ref !== expected.head.ref);
        if (switching) {
          const pending = await this.restoreCheckout(index, publish, target, expected, signal);
          source.pop();
          (redo ? journal.undo : journal.redo).push(entry);
          await this.saveJournal(journal);
          await rm(pending, { force: true });
          await this.pruneFiles(journal);
          return;
        }
        await writeFile(index, Buffer.from(target.index, 'base64'));
        await this.verifyIndex(index);
        const pending = join(this.directory, `pending-${randomUUID()}.json`);
        await atomic(
          pending,
          JSON.stringify({
            label: `${redo ? 'Redo' : 'Undo'} ${entry.label}`,
            before: expected,
            target,
          }),
        );
        if (!sameHead(target.head, expected.head)) {
          if (
            target.head.kind !== expected.head.kind ||
            (target.head.kind === 'branch' &&
              (expected.head.kind !== 'branch' || target.head.ref !== expected.head.ref))
          )
            throw new GitError(
              'STALE_UNDO',
              'The action changed branches; restore it with Git before using undo',
            );
          const ref = expected.head.kind === 'branch' ? expected.head.ref : 'HEAD';
          const args = target.head.oid
            ? [
                'update-ref',
                '--no-deref',
                ref,
                target.head.oid,
                expected.head.oid ?? '0'.repeat(target.head.oid.length),
              ]
            : ['update-ref', '--no-deref', '-d', ref, expected.head.oid!];
          await this.run(args, { readOnly: false });
        }
        const restoreRefs = async () => {
          if (target.refs && expected.refs)
            await this.restoreReferences(target.refs, expected.refs, signal);
        };
        if (target.branchConfig && expected.branchConfig)
          await this.configuration.restore(
            target.branchConfig,
            expected.branchConfig,
            restoreRefs,
            signal,
          );
        else await restoreRefs();
        if (target.files) await this.backups.restore(target.files, signal);
        if (!sameHead(target.head, expected.head) || current.signature !== target.signature)
          await publish();
        source.pop();
        (redo ? journal.undo : journal.redo).push(entry);
        await this.saveJournal(journal);
        await rm(pending, { force: true });
        await this.pruneFiles(journal);
      },
      signal,
      true,
    );
    return this.state();
  }
}
