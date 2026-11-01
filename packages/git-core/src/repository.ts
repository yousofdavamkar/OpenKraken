import { createHash } from 'node:crypto';
import { access, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { Commit, Repository, Snapshot } from '@openkraken/ipc-contract';
import { GitError, runGit, type RunOptions } from './runner.js';
import { HistoryParser, RefsParser, StatusParser, HISTORY_FORMAT, REF_FORMAT } from './parsers.js';
import { RepositoryQueue } from './queue.js';

async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
export class RepositoryService {
  private repositories = new Map<string, Repository>();
  private queues = new Map<string, RepositoryQueue>();
  private processPool = new RepositoryQueue(4);
  constructor(private git: string) {}
  private run(args: string[], options: RunOptions) {
    return this.processPool.run(
      options.readOnly === false,
      () => runGit(this.git, args, options),
      options.signal,
    );
  }
  private queue(key: string) {
    let q = this.queues.get(key);
    if (!q) {
      q = new RepositoryQueue();
      this.queues.set(key, q);
    }
    return q;
  }
  private async text(
    cwd: string,
    args: string[],
    signal?: AbortSignal,
    allowedExitCodes?: number[],
  ) {
    const result = await this.run(args, { cwd, signal, allowedExitCodes });
    return result.stdout.toString('utf8').replace(/\r?\n$/, '');
  }
  async open(input: string, signal?: AbortSignal): Promise<Repository> {
    const cwd = await realpath(input);
    const metadata = (
      await this.text(
        cwd,
        [
          'rev-parse',
          '--path-format=absolute',
          '--absolute-git-dir',
          '--git-common-dir',
          '--is-bare-repository',
          '--is-shallow-repository',
        ],
        signal,
      )
    ).split('\n');
    const [gitDir, commonDir, bare, shallow] = metadata;
    if (!gitDir || !commonDir || metadata.length !== 4)
      throw new GitError('INVALID_REPOSITORY', 'Cannot read repository metadata');
    const path = await realpath(
      bare === 'true' ? gitDir : await this.text(cwd, ['rev-parse', '--show-toplevel'], signal),
    );
    const [headRef, headOid, sparse] = await Promise.all([
      this.text(cwd, ['symbolic-ref', '-q', 'HEAD'], signal, [0, 1]),
      this.text(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'], signal, [0, 1]),
      this.text(cwd, ['config', '--bool', '--get', 'core.sparseCheckout'], signal, [0, 1]),
    ]);
    const stateMarkers: [string, Repository['state']][] = [
      ['rebase-merge/interactive', 'rebasing-interactive'],
      ['rebase-merge', 'rebasing'],
      ['rebase-apply/applying', 'applying-mailbox'],
      ['rebase-apply', 'rebasing'],
      ['MERGE_HEAD', 'merging'],
      ['CHERRY_PICK_HEAD', 'cherry-picking'],
      ['REVERT_HEAD', 'reverting'],
      ['BISECT_LOG', 'bisecting'],
    ];
    let state: Repository['state'] = 'clean';
    for (const [marker, candidate] of stateMarkers)
      if (await exists(join(gitDir, marker))) {
        state = candidate;
        break;
      }
    if (!headRef && !headOid)
      throw new GitError('INVALID_HEAD', 'Repository HEAD cannot be resolved');
    const repository: Repository = {
      id: createHash('sha256').update(path).digest('hex'),
      path,
      gitDir: await realpath(gitDir),
      commonDir: await realpath(commonDir),
      isBare: bare === 'true',
      isShallow: shallow === 'true',
      isSparse: sparse === 'true',
      head: headRef
        ? { kind: 'branch', ref: headRef, ...(headOid ? { oid: headOid } : {}) }
        : { kind: 'detached', oid: headOid },
      state,
    };
    this.repositories.set(repository.id, repository);
    return repository;
  }
  async init(path: string, branch = 'main', signal?: AbortSignal) {
    const canonical = await realpath(path);
    await this.queue(canonical).run(
      true,
      async () => {
        if ((await exists(join(canonical, '.git'))) || (await exists(join(canonical, 'HEAD'))))
          throw new GitError(
            'ALREADY_EXISTS',
            'The selected folder already contains repository metadata',
          );
        await this.run(['check-ref-format', '--branch', branch], {
          cwd: canonical,
          signal,
        });
        await this.run(['init', `--initial-branch=${branch}`, '--', canonical], {
          cwd: canonical,
          signal,
          readOnly: false,
        });
      },
      signal,
    );
    return this.open(canonical, signal);
  }
  async discover(path: string, signal?: AbortSignal, depth = 2) {
    const found = new Set<string>();
    let visited = 0;
    const walk = async (folder: string, remaining: number): Promise<void> => {
      if (signal?.aborted) throw new GitError('CANCELLED', 'Operation cancelled');
      if (++visited > 5000)
        throw new GitError('DISCOVERY_LIMIT', 'Folder scan exceeded 5,000 directories');
      if (
        (await exists(join(folder, '.git'))) ||
        ((await exists(join(folder, 'HEAD'))) && (await exists(join(folder, 'objects'))))
      ) {
        try {
          found.add((await this.open(folder, signal)).path);
        } catch (error) {
          if (signal?.aborted) throw error;
        }
      }
      if (!remaining) return;
      const entries = await readdir(folder, { withFileTypes: true });
      for (const entry of entries)
        if (
          entry.isDirectory() &&
          !['.git', 'node_modules', 'vendor', 'dist', '.cache'].includes(entry.name)
        )
          await walk(join(folder, entry.name), remaining - 1);
    };
    await walk(await realpath(path), depth);
    return [...found].sort();
  }
  async snapshot(id: string, signal?: AbortSignal, refresh = true): Promise<Snapshot> {
    const known = this.repositories.get(id);
    if (!known) throw new GitError('UNKNOWN_REPOSITORY', 'Open this repository first');
    const start = performance.now();
    return this.queue(known.commonDir).run(
      false,
      async () => {
        const repository = refresh ? await this.open(known.path, signal) : known;
        const refsParser = new RefsParser(),
          statusParser = new StatusParser();
        await Promise.all([
          this.run(['for-each-ref', `--format=${REF_FORMAT}`], {
            cwd: repository.path,
            signal,
            onStdout: (b) => refsParser.push(b),
          }),
          repository.isBare
            ? Promise.resolve()
            : this.run(
                [
                  'status',
                  '--porcelain=v2',
                  '-z',
                  '--branch',
                  '--untracked-files=all',
                  '--renames',
                ],
                { cwd: repository.path, signal, onStdout: (b) => statusParser.push(b) },
              ),
        ]);
        const refs = refsParser.finish(),
          status = statusParser.finish();
        // Filter non-commit tags. Explicit OIDs on stdin avoid ref/option ambiguity.
        const starts = new Set(
          refs
            .filter(
              (r) => r.kind !== 'stash' && (r.objectType === 'commit' || r.peeledType === 'commit'),
            )
            .map((r) => r.peeled ?? r.target),
        );
        if (repository.head.oid) starts.add(repository.head.oid);
        // Walk stash bases with normal history, but hide index/untracked parents.
        let stashCommits: Commit[] = [];
        if (refs.some((r) => r.kind === 'stash')) {
          const stashes = new HistoryParser();
          await this.run(
            ['log', '-g', '--max-count=200', `--format=commit %H%n${HISTORY_FORMAT}`, 'refs/stash'],
            { cwd: repository.path, signal, onStdout: (b) => stashes.push(b) },
          );
          stashCommits = stashes
            .finish()
            .map((c) => ({ ...c, parents: c.parents.slice(0, 1), isStash: true }));
          for (const stash of stashCommits) if (stash.parents[0]) starts.add(stash.parents[0]);
        }
        const parser = new HistoryParser();
        if (starts.size)
          await this.run(
            [
              'rev-list',
              '--date-order',
              '--parents',
              '--max-count=2001',
              `--format=${HISTORY_FORMAT}`,
              '--stdin',
            ],
            {
              cwd: repository.path,
              signal,
              stdin: [...starts].join('\n') + '\n',
              onStdout: (b) => parser.push(b),
            },
          );
        let commits = parser.finish();
        if (stashCommits.length) commits = orderCommits([...commits, ...stashCommits]);
        return {
          repository,
          refs,
          status,
          commits: commits.slice(0, 2000),
          hasMore: commits.length > 2000,
          elapsedMs: performance.now() - start,
        };
      },
      signal,
    );
  }
}
export function orderCommits(commits: Commit[]): Commit[] {
  const unique = new Map(commits.map((c) => [c.oid, c]));
  const children = new Map<string, number>();
  for (const c of unique.values())
    for (const p of c.parents) children.set(p, (children.get(p) ?? 0) + 1);
  const ready = [...unique.values()].filter((c) => !children.get(c.oid));
  const result: Commit[] = [];
  while (ready.length) {
    ready.sort((a, b) => b.committer.time - a.committer.time || a.oid.localeCompare(b.oid));
    const c = ready.shift()!;
    result.push(c);
    for (const p of c.parents) {
      const count = children.get(p)! - 1;
      children.set(p, count);
      if (!count && unique.has(p)) ready.push(unique.get(p)!);
    }
  }
  return result;
}
