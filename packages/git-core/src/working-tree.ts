import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, open, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { headSchema, type Repository } from '@openkraken/ipc-contract';
import { GitError, runGit, type RunOptions } from './runner.js';
import { StatusParser } from './parsers.js';
const MAX_INDEX = 32 * 1024 * 1024;
const savedSchema = z.object({
  head: headSchema,
  index: z.string().max(MAX_INDEX * 2),
  signature: z.string(),
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
/** Git writes are serialized by RepositoryService and protected from external index writers. */
export class WorkingTree {
  private directory: string;
  constructor(
    private git: string,
    readonly repo: Repository,
    dataDir: string,
  ) {
    if (!/^[0-9a-f]{64}$/.test(repo.id)) throw new Error('Invalid repository');
    this.directory = join(dataDir, 'undo', repo.id);
  }
  private run(args: string[], options: RunOptions = {}) {
    return runGit(this.git, ['--literal-pathspecs', ...args], { cwd: this.repo.path, ...options });
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
    while (journal.undo.length + journal.redo.length > 20) journal.undo.shift();
    let data = JSON.stringify(journal);
    while (Buffer.byteLength(data) > 128 * 1024 * 1024 && journal.undo.length > 1) {
      journal.undo.shift();
      data = JSON.stringify(journal);
    }
    if (Buffer.byteLength(data) > 128 * 1024 * 1024)
      throw new GitError('UNDO_LIMIT', 'Undo backup exceeds 128 MiB');
    await atomic(join(this.directory, 'journal.json'), data);
  }
  async state(signal?: AbortSignal) {
    const parser = new StatusParser();
    if (!this.repo.isBare)
      await this.run(
        ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all', '--renames'],
        { signal, onStdout: (b) => parser.push(b) },
      );
    const journal = await this.journal();
    const brief = (entry?: z.infer<typeof entrySchema>) =>
      entry ? { id: entry.id, label: entry.label } : undefined;
    return {
      status: parser.finish(),
      head: await this.head(signal),
      undo: brief(journal.undo.at(-1)),
      redo: brief(journal.redo.at(-1)),
    };
  }
  private async saved(indexFile: string): Promise<Saved> {
    const index = await readFile(indexFile);
    if (index.length > MAX_INDEX)
      throw new GitError('UNDO_LIMIT', 'The index exceeds the 32 MiB undo limit');
    const [head, entries, diff] = await Promise.all([
      this.head(),
      this.run(['ls-files', '--stage', '-v', '-z'], { indexFile }),
      this.run(['diff', '--cached', '--raw', '-z', '--no-ext-diff', '--no-renames'], { indexFile }),
    ]);
    return {
      head,
      index: index.toString('base64'),
      signature: hash(Buffer.concat([entries.stdout, diff.stdout])),
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
        await copyFile(join(this.repo.gitDir, 'index'), index);
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
    change: (index: string) => Promise<void>,
    signal?: AbortSignal,
  ) {
    await this.locked(async (index, publish) => {
      const before = await this.saved(index),
        journal = await this.journal(),
        id = randomUUID();
      const pending = join(this.directory, `pending-${id}.json`);
      await atomic(pending, JSON.stringify({ id, label, before }));
      try {
        await change(index);
      } catch (error) {
        if (sameHead(before.head, await this.head())) await rm(pending, { force: true });
        throw error;
      }
      const after = await this.saved(index);
      if (!sameHead(before.head, after.head) || before.signature !== after.signature) {
        journal.undo.push({ id, label, before, after });
        journal.redo = [];
        await this.saveJournal(journal);
        await publish();
      }
      await rm(pending, { force: true });
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
      await writeFile(index, Buffer.from(target.index, 'base64'));
      if (!sameHead(target.head, expected.head))
        throw new GitError('UNDO_UNSUPPORTED', 'This action cannot restore HEAD yet');
      await publish();
      source.pop();
      (redo ? journal.undo : journal.redo).push(entry);
      await this.saveJournal(journal);
    }, signal);
    return this.state();
  }
}
