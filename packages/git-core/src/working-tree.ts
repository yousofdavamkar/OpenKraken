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
  type WorkingState,
  type WorkingDiff,
  type PatchOptions,
  type Repository,
} from '@openkraken/ipc-contract';
import { GitError, runGit, type RunOptions } from './runner.js';
import { RepositoryQueue } from './queue.js';
import { FileBackups, fileImageSchema, sameImages, type FileImage } from './file-backups.js';
import { parsePatch, selectPatch } from './patch.js';
import { StatusParser } from './parsers.js';
const MAX_INDEX = 32 * 1024 * 1024;
const savedSchema = z.object({
  head: headSchema,
  index: z.string().max(MAX_INDEX * 2),
  signature: z.string(),
  files: z.array(fileImageSchema).optional(),
});
const entrySchema = z.object({
  id: z.string().uuid(),
  label: z.string(),
  before: savedSchema,
  after: savedSchema,
});
const journalSchema = z.object({
  undo: z.array(entrySchema).max(20),
  redo: z.array(entrySchema).max(20),
});
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
  private processes = new RepositoryQueue(3);
  constructor(
    private git: string,
    readonly repo: Repository,
    dataDir: string,
  ) {
    if (!/^[0-9a-f]{64}$/.test(repo.id)) throw new Error('Invalid repository');
    this.directory = join(dataDir, 'undo', repo.id);
    this.backups = new FileBackups(repo.path, this.directory);
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
  private async saved(indexFile: string, files?: string[], signal?: AbortSignal): Promise<Saved> {
    if ((await stat(indexFile)).size > MAX_INDEX)
      throw new GitError('UNDO_LIMIT', 'The index exceeds the 32 MiB undo limit');
    const index = await readFile(indexFile);
    if (index.length > MAX_INDEX)
      throw new GitError('UNDO_LIMIT', 'The index exceeds the 32 MiB undo limit');
    return {
      index: index.toString('base64'),
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
  ) {
    if (this.repo.isBare)
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
  ) {
    await this.locked(async (index, publish) => {
      const journal = await this.journal();
      await this.pruneFiles(journal);
      const before = await this.saved(index, files, signal),
        id = randomUUID();
      const pending = join(this.directory, `pending-${id}.json`);
      await atomic(pending, JSON.stringify({ id, label, before }));
      let failure: unknown;
      try {
        await change(index, before);
      } catch (error) {
        failure = error;
      }
      const after = await this.saved(index, files);
      if (!movesHead && !sameHead(before.head, after.head))
        throw new GitError(
          'CONCURRENT_HEAD',
          `HEAD changed during the operation; the index was not published. Recovery backup: ${pending}`,
        );
      if (
        !sameHead(before.head, after.head) ||
        before.signature !== after.signature ||
        !sameImages(before.files, after.files)
      ) {
        journal.undo.push({ id, label, before, after });
        journal.redo = [];
        await this.saveJournal(journal);
        await publish();
      }
      await rm(pending, { force: true });
      await this.pruneFiles(journal);
      if (failure) throw failure;
    }, signal);
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
        if (
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
  async undo(redo = false, signal?: AbortSignal) {
    await this.locked(async (index, publish) => {
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
      await writeFile(index, Buffer.from(target.index, 'base64'));
      await this.verifyIndex(index);
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
      if (target.files) await this.backups.restore(target.files, signal);
      await publish();
      source.pop();
      (redo ? journal.undo : journal.redo).push(entry);
      await this.saveJournal(journal);
      await this.pruneFiles(journal);
    }, signal);
    return this.state();
  }
}
