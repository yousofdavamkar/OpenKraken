import { graphRefVisibility } from '@openkraken/ipc-contract';
import { LfsTransfers, type LfsPullPlan } from './lfs-transfers.js';
import { lfsState } from './lfs.js';
import { LfsSetup, type LfsSetupPlan } from './lfs-setup.js';
import type { ProviderGitTarget, ProviderRemoteAuthorization } from '@openkraken/ipc-contract';
import { createHash } from 'node:crypto';
import { access, readdir, realpath, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  Commit,
  CommitOptions,
  CommitComparisonOptions,
  WorkingFileOptions,
  WorkingComparisonOptions,
  SaveWorkingFile,
  FileHistoryOptions,
  BlameOptions,
  BlameLine,
  CloneOptions,
  PatchOptions,
  ReferenceOptions,
  RemoteOptions,
  PushSelection,
  PushOptions,
  DeleteRemoteSelection,
  DeleteRemotePlan,
  PullOptions,
  OperationAction,
  StartOperation,
  InteractiveRebase,
  ResetSelection,
  ResolveConflict,
  StashPushOptions,
  StashActionOptions,
  WorktreeAdd,
  WorktreeAction,
  GraphView,
  Repository,
  Ref,
  Snapshot,
} from '@openkraken/ipc-contract';
import { GitError, runGit, type RunOptions } from './runner.js';
import { rawHistoryStream, StatusParser } from './parsers.js';
import { samplePackedRefs, ReferenceReader, type PackedRefSample } from './reference-reader.js';
import { HistoryCache } from './history-cache.js';
import { RepositoryPreferences } from './preferences.js';
import { HistoryCursor } from './history.js';
import { Remotes, transportError } from './remotes.js';
import { predictMerge } from './merge-prediction.js';
import { commitFiles } from './commit-files.js';
import { blame } from './blame.js';
import { fileHistory } from './file-history.js';
import { commitComparison } from './file-comparison.js';
import { WorkingTree } from './working-tree.js';
import { Worktrees, type WorktreePrunePlan } from './worktrees.js';
import { Submodules } from './submodules.js';
import { SubmoduleUpdates, type SubmoduleUpdatePlan } from './submodule-updates.js';
import { SubmoduleSync, type SubmoduleSyncPlan } from './submodule-sync.js';
import type { GitEditor } from './editor-document.js';
import { RepositoryQueue } from './queue.js';

const FIRST_PAGE_SIZE = 2000;

async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
function addVisibleHead(
  starts: Set<string>,
  head: Repository['head'],
  view: GraphView,
  isVisible: (name: string) => boolean,
) {
  if (head.oid && !view.soloRef && (head.kind === 'detached' || isVisible(head.ref)))
    starts.add(head.oid);
}

type SnapshotObserver = {
  status: (chunk: Buffer) => void;
  refs?: (refs: Snapshot['refs']) => void;
};

export class RepositoryService {
  private repositories = new Map<string, Repository>();
  private queues = new Map<string, RepositoryQueue>();
  private histories = new Map<string, HistoryCursor>();
  private snapshotQueue = new RepositoryQueue(1);
  private lfsPullPlans = new Map<string, LfsPullPlan>();
  private lfsSetupPlans = new Map<string, LfsSetupPlan>();
  private submoduleUpdates = new Map<string, SubmoduleUpdatePlan>();
  private submoduleSyncPlans = new Map<string, SubmoduleSyncPlan>();
  private worktreePrunes = new Map<string, WorktreePrunePlan>();
  private processPool = new RepositoryQueue(3);
  private preferences: RepositoryPreferences;
  private referenceReader = new ReferenceReader((args, options) => this.run(args, options));
  private dataDir?: string;
  private editorHelper?: string;
  private cache?: HistoryCache;
  constructor(
    private git: string,
    options: { dataDir?: string; editorHelper?: string } = {},
  ) {
    this.preferences = new RepositoryPreferences(options.dataDir);
    this.dataDir = options.dataDir;
    this.editorHelper = options.editorHelper;
  }
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
    // POSIX permits a carriage return as the last byte of a repository path.
    return result.stdout
      .toString('utf8')
      .replace(process.platform === 'win32' ? /\r?\n$/ : /\n$/, '');
  }
  async clone(
    input: string,
    options: CloneOptions,
    signal?: AbortSignal,
    onProgress?: (text: string) => void,
    authentication?: NodeJS.ProcessEnv,
    provider?: ProviderGitTarget,
  ) {
    const path = await realpath(input);
    return this.queue(path).run(
      true,
      async () => {
        if ((await readdir(path)).length)
          throw new GitError(
            'CLONE_DESTINATION_NOT_EMPTY',
            'Choose an empty folder for this clone',
          );
        const manager = new Remotes(
          (args, settings) => this.run(args, { ...settings, cwd: path }),
          onProgress,
          authentication,
        );
        await manager.clone(options, signal, provider);
        return this.open(path, signal);
      },
      signal,
    );
  }
  async open(input: string, signal?: AbortSignal): Promise<Repository> {
    const cwd = await realpath(input);
    const [description, headRef, sparse] = await Promise.all([
      this.text(
        cwd,
        [
          'rev-parse',
          '--path-format=absolute',
          '--absolute-git-dir',
          '--git-common-dir',
          '--is-bare-repository',
          '--is-shallow-repository',
          '--verify',
          '--quiet',
          'HEAD',
        ],
        signal,
        [0, 1],
      ),
      this.text(cwd, ['symbolic-ref', '-q', 'HEAD'], signal, [0, 1]),
      this.text(cwd, ['config', '--bool', '--get', 'core.sparseCheckout'], signal, [0, 1]),
    ]);
    const metadata = description.split(process.platform === 'win32' ? /\r?\n/ : '\n');
    // An unborn HEAD leaves the two paths and booleans intact, without a trailing object ID.
    const headOid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(metadata.at(-1) ?? '')
      ? metadata.pop()!
      : '';
    let [gitDir, commonDir] = metadata;
    const [bare, shallow] = metadata.slice(-2);
    // rev-parse separates values with newlines even when a path contains one.
    // Keep the common fast path, but read paths individually when ambiguous.
    if (metadata.length > 4)
      [gitDir, commonDir] = await Promise.all([
        this.text(cwd, ['rev-parse', '--path-format=absolute', '--absolute-git-dir'], signal),
        this.text(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'], signal),
      ]);
    if (
      !gitDir ||
      !commonDir ||
      metadata.length < 4 ||
      !['true', 'false'].includes(bare!) ||
      !['true', 'false'].includes(shallow!)
    )
      throw new GitError('INVALID_REPOSITORY', 'Cannot read repository metadata');
    const path = await realpath(
      bare === 'true' ? gitDir : await this.text(cwd, ['rev-parse', '--show-toplevel'], signal),
    );
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
  async snapshot(
    id: string,
    signal?: AbortSignal,
    refresh = true,
    requestedView?: GraphView,
  ): Promise<Snapshot> {
    return this.readSnapshot(id, signal, refresh, requestedView);
  }

  async observeInitialSnapshot(
    id: string,
    signal?: AbortSignal,
    observeRefs?: (refs: Snapshot['refs']) => void,
  ) {
    const status = createHash('sha256');
    const snapshot = await this.readSnapshot(id, signal, false, undefined, {
      status: (chunk) => status.update(chunk),
      refs: observeRefs,
    });
    return { snapshot, statusHash: status.digest('hex') };
  }

  private readSnapshot(
    id: string,
    signal: AbortSignal | undefined,
    refresh: boolean,
    requestedView?: GraphView,
    observe?: SnapshotObserver,
  ): Promise<Snapshot> {
    const start = performance.now();
    return this.snapshotQueue.run(
      false,
      () => this.prepareSnapshot(id, signal, refresh, requestedView, start, observe),
      signal,
    );
  }
  private async prepareSnapshot(
    id: string,
    signal: AbortSignal | undefined,
    refresh: boolean,
    requestedView: GraphView | undefined,
    start: number,
    observe?: SnapshotObserver,
  ): Promise<Snapshot> {
    const known = this.repositories.get(id);
    if (!known) throw new GitError('UNKNOWN_REPOSITORY', 'Open this repository first');
    return this.queue(known.commonDir).run(
      false,
      async () => {
        this.cache?.stopReadingTails();
        const [view, packedRefs] = await Promise.all([
          requestedView ?? this.preferences.load(id),
          samplePackedRefs(known.commonDir),
        ]);
        const repository = refresh ? await this.open(known.path, signal) : known;
        const stop = new AbortController();
        const readSignal = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
        const probeStop = new AbortController();
        let prefetch: Promise<HistoryCursor | undefined> | undefined;
        const refRead = this.referenceReader.read(
          repository.path,
          readSignal,
          packedRefs,
          (objects) => {
            if (!refresh)
              prefetch = this.prefetchHistory(
                repository,
                view,
                packedRefs,
                AbortSignal.any([readSignal, probeStop.signal]),
                objects,
              ).catch(() => undefined);
          },
        );
        const worktreeRead = exists(join(repository.commonDir, 'worktrees')).then((present) =>
          present ? this.worktreeManager(id).manager.list(readSignal) : undefined,
        );
        const statusRead = this.readSnapshotStatus(repository, readSignal, observe?.status);
        const cacheReads = this.cacheFingerprintReads(repository, readSignal);
        // On startup there is no outgoing cache writer. Check the file while Git reads refs,
        // then compare its stamp and the snapshot fingerprint before adopting any commits.
        const earlyPrefix =
          !refresh && !this.cache && cacheReads.length && this.dataDir
            ? HistoryCache.prefetchPrefix(this.dataDir, repository.id, readSignal)
            : undefined;
        const cacheFlush = this.cache?.flush();
        const graphRead = Promise.all([refRead, worktreeRead, Promise.all(cacheReads)]).then(
          async ([refs, worktrees, cacheInputs]) => {
            // The normal snapshot can start now. Only reuse a walk already in progress.
            probeStop.abort();
            if (!readSignal.aborted) observe?.refs?.(refs);
            return this.prepareHistory(
              repository,
              view,
              refs,
              worktrees,
              cacheInputs,
              cacheFlush,
              readSignal,
              await prefetch,
              earlyPrefix,
            );
          },
        );
        let graph: Awaited<typeof graphRead>;
        let status: Snapshot['status'];
        try {
          [graph, status] = await Promise.all([graphRead, statusRead, cacheFlush]);
          if (requestedView) await this.preferences.save(id, requestedView);
          if (signal?.aborted) throw new GitError('CANCELLED', 'Snapshot loading cancelled');
        } catch (error) {
          stop.abort();
          const [candidate] = await Promise.allSettled([
            graphRead,
            statusRead,
            refRead,
            worktreeRead,
            ...cacheReads,
            cacheFlush,
          ]);
          if (candidate.status === 'fulfilled') await candidate.value.history.close();
          else await (await prefetch)?.close();
          throw error;
        }
        const { history, cache, page, refs, worktrees, pinnedOid } = graph;
        // Commit the prepared snapshot only after all fallible reads complete.
        // Keep the displayed cursor and its cache usable on failure/cancellation.
        for (const cursor of this.histories.values()) await cursor.close();
        await this.cache?.flush();
        this.histories.clear();
        this.histories.set(id, history);
        this.cache = cache;
        cache?.record(0, page.commits, page.hasMore);
        return {
          repository,
          view,
          worktrees,
          pinnedOid,
          refs,
          status,
          commits: page.commits,
          hasMore: page.hasMore,
          cursor: history.id,
          elapsedMs: performance.now() - start,
        };
      },
      signal,
    );
  }
  private async readSnapshotStatus(
    repository: Repository,
    signal: AbortSignal,
    observeStatus?: (chunk: Buffer) => void,
  ) {
    const parser = new StatusParser();
    if (!repository.isBare) {
      await this.run(
        ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all', '--renames'],
        {
          cwd: repository.path,
          signal,
          onStdout: (chunk) => {
            parser.push(chunk);
            observeStatus?.(chunk);
          },
        },
      );
    }
    return parser.finish();
  }
  private cacheFingerprintReads(repository: Repository, signal: AbortSignal) {
    if (
      !this.dataDir ||
      process.env.GIT_GRAFT_FILE !== undefined ||
      process.env.GIT_SHALLOW_FILE !== undefined ||
      process.env.GIT_REPLACE_REF_BASE !== undefined ||
      process.env.GIT_NO_REPLACE_OBJECTS !== undefined
    )
      return [];
    return [
      this.text(repository.path, ['--version'], signal),
      this.text(repository.path, ['config', '--null', '--list'], signal),
      ...['shallow', 'info/grafts', 'objects/info/alternates'].map((p) =>
        readFile(join(repository.commonDir, p))
          .then((b) => b.toString('base64'))
          .catch(() => ''),
      ),
      ...['objects/info/commit-graph', 'objects/info/commit-graphs/commit-graph-chain'].map((p) =>
        stat(join(repository.commonDir, p))
          .then((s) => `${s.size}:${s.mtimeMs}`)
          .catch(() => ''),
      ),
    ];
  }
  private async prefetchHistory(
    repository: Repository,
    view: GraphView,
    sample: PackedRefSample,
    signal: AbortSignal,
    objects?: ReadonlyMap<string, Ref>,
  ) {
    if (
      (sample.repeatedTargets && !view.soloRef && view.hiddenRefs.length > 0) ||
      repository.isShallow ||
      process.env.GIT_REPLACE_REF_BASE !== undefined ||
      process.env.GIT_SHALLOW_FILE !== undefined ||
      process.env.GIT_GRAFT_FILE !== undefined
    )
      return;
    // File size is only a scheduling hint. Git supplies every tentative root.
    const packed = await stat(join(repository.commonDir, 'packed-refs')).catch(() => undefined);
    if (!packed || packed.size < 512 * 1024) return;
    if (
      (await exists(join(repository.commonDir, 'info/grafts'))) ||
      (this.dataDir && (await HistoryCache.hasPrefix(this.dataDir, repository.id)))
    )
      return;
    if (signal.aborted) return;
    const head = repository.head;
    const unfiltered = !view.soloRef && view.hiddenRefs.length === 0;
    // Only the native snapshot can confirm that no loose or later packed ref adds a root.
    if (
      head.oid &&
      ((head.kind === 'branch' && view.soloRef === head.ref) ||
        (unfiltered && sample.singleTarget === head.oid))
    )
      return new HistoryCursor(
        this.git,
        repository.path,
        [head.oid],
        [],
        undefined,
        FIRST_PAGE_SIZE,
      );
    const isVisible = graphRefVisibility(view);
    const starts = new Set<string>();
    if (unfiltered && objects) {
      for (const ref of objects.values()) {
        if (ref.objectType === 'commit') starts.add(ref.target);
        else if (ref.peeledType === 'commit' && ref.peeled) starts.add(ref.peeled);
      }
    } else {
      const args = unfiltered
        ? ['rev-parse', '--all']
        : [
            'for-each-ref',
            '--format=%(objectname) %(refname)',
            ...(view.soloRef ? ['--', view.soloRef] : []),
          ];
      const { stdout } = await this.run(args, {
        cwd: repository.path,
        signal,
        maxBytes: 8 * 1024 * 1024,
      });
      if (signal.aborted) return;
      const lines = stdout.toString('utf8').split('\n');
      if (lines.pop() !== '') return;
      for (const line of lines) {
        const separator = unfiltered ? -1 : line.indexOf(' ');
        if (!unfiltered && separator === -1) return;
        if (!unfiltered && !isVisible(line.slice(separator + 1))) continue;
        starts.add(unfiltered ? line : line.slice(0, separator));
      }
      for (const oid of starts) if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) return;
    }
    addVisibleHead(starts, head, view, isVisible);
    return new HistoryCursor(
      this.git,
      repository.path,
      [...starts],
      [],
      undefined,
      FIRST_PAGE_SIZE,
    );
  }
  private async prepareHistory(
    repository: Repository,
    view: GraphView,
    refs: Snapshot['refs'],
    worktrees: Snapshot['worktrees'],
    cacheInputs: string[],
    cacheFlush: Promise<void> | undefined,
    signal: AbortSignal,
    candidate?: HistoryCursor,
    earlyPrefix?: ReturnType<typeof HistoryCache.prefetchPrefix>,
  ) {
    // Keep missing ref preferences: a deleted solo ref must not silently reveal all history.
    const isVisible = graphRefVisibility(view);
    const starts = new Set<string>();
    let hasStash = false;
    let pinnedOid: string | undefined;
    for (const ref of refs) {
      if (!isVisible(ref.name)) continue;
      if (ref.kind === 'stash') {
        hasStash = true;
        continue;
      }
      // Filter non-commit tags. Explicit OIDs on stdin avoid ref/option ambiguity.
      if (ref.objectType !== 'commit' && ref.peeledType !== 'commit') continue;
      const oid = ref.peeled ?? ref.target;
      starts.add(oid);
      if (ref.name === view.pinnedRef) pinnedOid = oid;
    }
    addVisibleHead(starts, repository.head, view, isVisible);
    for (const worktree of worktrees?.entries ?? []) {
      if (worktree.current || !worktree.head) continue;
      const visible = worktree.branch ? isVisible(worktree.branch) : !view.soloRef;
      if (visible) starts.add(worktree.head);
    }
    // Walk stash bases with normal history, but hide index/untracked parents.
    let stashCommits: Commit[] = [];
    if (hasStash) {
      const { parser: stashes, formatArgs } = rawHistoryStream('log');
      await this.run(['log', '-g', '--max-count=200', ...formatArgs, 'refs/stash'], {
        cwd: repository.path,
        signal,
        onStdout: (b) => stashes.push(b),
      });
      stashCommits = stashes
        .finish()
        .map((c) => ({ ...c, parents: c.parents.slice(0, 1), isStash: true }));
      for (const stash of stashCommits) if (stash.parents[0]) starts.add(stash.parents[0]);
    }
    // The previous cache may be writing this prefix or trimming other repositories.
    await cacheFlush;
    let cache: HistoryCache | undefined;
    if (this.dataDir && cacheInputs.length) {
      const [version, config, ...metadata] = cacheInputs;
      const key = createHash('sha256')
        .update(
          JSON.stringify({
            format: 2,
            version,
            config,
            metadata,
            starts: [...starts],
            stashes: stashCommits.map((c) => c.oid),
            replacements: refs.filter((r) => r.name.startsWith('refs/replace/')),
          }),
        )
        .digest('hex');
      cache = new HistoryCache(this.dataDir, repository.id, key);
    }
    const seed = await cache?.load(signal, earlyPrefix);
    if (signal.aborted) throw new GitError('CANCELLED', 'Snapshot loading cancelled');
    const ordered = [...starts];
    if (candidate) {
      if (
        !seed &&
        !hasStash &&
        !refs.some((ref) => ref.name.startsWith('refs/replace/')) &&
        candidate.confirmRoots(ordered, refs) &&
        !(await exists(join(repository.commonDir, 'shallow'))) &&
        !(await exists(join(repository.commonDir, 'info/grafts')))
      ) {
        try {
          const page = await candidate.page(0, FIRST_PAGE_SIZE, signal);
          return { history: candidate, cache, page, refs, worktrees, pinnedOid };
        } catch (error) {
          if (signal.aborted) throw error;
        }
      }
      await candidate.close();
    }
    const history = new HistoryCursor(this.git, repository.path, ordered, stashCommits, seed);
    try {
      const page = await history.page(0, FIRST_PAGE_SIZE, signal);
      return { history, cache, page, refs, worktrees, pinnedOid };
    } catch (error) {
      await history.close();
      throw error;
    }
  }
  private history(id: string, cursor: string) {
    const history = this.histories.get(id);
    if (!history || history.id !== cursor)
      throw new GitError('STALE_CURSOR', 'History changed; refresh to restart');
    return history;
  }
  async page(id: string, cursor: string, offset: number, count: number, signal?: AbortSignal) {
    const cache = this.cache;
    const result = await this.history(id, cursor).page(offset, count, signal);
    cache?.record(offset, result.commits, result.hasMore);
    return result;
  }
  private async resolveSearchCommit(path: string, prefix: string, signal?: AbortSignal) {
    const object = await this.text(path, ['rev-parse', `--disambiguate=${prefix}`], signal);
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(object) || !object.startsWith(prefix)) return '';
    return this.text(
      path,
      ['rev-parse', '--verify', '--quiet', '--end-of-options', `${object}^{commit}`],
      signal,
      [0, 1],
    );
  }
  private async searchMessagesAndAuthors(
    path: string,
    starts: readonly string[],
    query: string,
    signal?: AbortSignal,
  ) {
    const stop = new AbortController();
    const scanSignal = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
    const roots = starts.join('\n') + '\n';
    const find = async (filter: string) => {
      const { parser, formatArgs } = rawHistoryStream('log');
      if (starts.length)
        await this.run(
          [
            'log',
            '--date-order',
            '--max-count=101',
            '--regexp-ignore-case',
            '--fixed-strings',
            filter,
            ...formatArgs,
            '--stdin',
          ],
          {
            cwd: path,
            signal: scanSignal,
            timeoutMs: 120_000,
            stdin: roots,
            onStdout: (b) => parser.push(b),
          },
        );
      return parser.finish();
    };
    const scans = [find(`--grep=${query}`), find(`--author=${query}`)] as const;
    try {
      return await Promise.all(scans);
    } catch (error) {
      stop.abort();
      await Promise.allSettled(scans);
      throw error;
    }
  }
  async search(id: string, cursor: string, query: string, signal?: AbortSignal) {
    const history = this.history(id, cursor);
    const repo = this.repositories.get(id)!;
    const [messages, authors] = await this.searchMessagesAndAuthors(
      repo.path,
      history.starts,
      query,
      signal,
    );
    const queryLower = query.toLocaleLowerCase();
    const stashes = history.stashes.filter((c) =>
      [c.body, c.author.name, c.author.email].some((value) =>
        value.toLocaleLowerCase().includes(queryLower),
      ),
    );
    const matches = new Map([...stashes, ...messages, ...authors].map((c) => [c.oid, c]));
    let exact: Commit | undefined;
    if ((history.starts.length || history.stashes.length) && /^[0-9a-f]{7,64}$/i.test(query)) {
      const resolved = await this.resolveSearchCommit(repo.path, query.toLowerCase(), signal);
      exact = matches.get(resolved);
      if (exact?.isStash) exact = undefined;
      let reachable = history.starts.includes(resolved);
      if (resolved && !exact && !reachable && history.starts.length) {
        // Subtract all visible history. An empty range puts the commit in this view.
        const remaining = await this.run(['rev-list', '--max-count=1', '--stdin'], {
          cwd: repo.path,
          signal,
          stdin: resolved + '\n^' + history.starts.join('\n^') + '\n',
        });
        reachable = remaining.stdout.length === 0;
      }
      if (reachable && !exact) {
        const { parser, formatArgs } = rawHistoryStream('log');
        await this.run(['log', '-1', ...formatArgs, resolved, '--'], {
          cwd: repo.path,
          signal,
          onStdout: (b) => parser.push(b),
        });
        [exact] = parser.finish();
      }
      exact ??= history.stashes.find((stash) => stash.oid === resolved);
    }
    this.history(id, cursor);
    if (exact) matches.delete(exact.oid);
    const commits = [...matches.values()].sort((a, b) => b.committer.time - a.committer.time);
    if (exact) commits.unshift(exact);
    return { cursor, commits: commits.slice(0, 100), truncated: commits.length > 100 };
  }
  private workingTrees = new Map<string, WorkingTree>();
  private working(id: string) {
    const repo = this.repositories.get(id);
    if (!repo) throw new GitError('UNKNOWN_REPOSITORY', 'Open this repository first');
    if (!this.dataDir)
      throw new GitError(
        'PROFILE_REQUIRED',
        'A profile directory is required for recoverable working-tree operations',
      );
    let work = this.workingTrees.get(id);
    if (!work) {
      work = new WorkingTree(this.git, repo, this.dataDir, this.editorHelper);
      this.workingTrees.set(id, work);
    }
    return work;
  }
  private remoteManager(
    id: string,
    onProgress?: (text: string) => void,
    authentication?: NodeJS.ProcessEnv,
    provider?: ProviderRemoteAuthorization,
  ) {
    const repo = this.repositories.get(id);
    if (!repo) throw new GitError('UNKNOWN_REPOSITORY', 'Open this repository first');
    return {
      repo,
      manager: new Remotes(
        (args, options) => this.run(args, { ...options, cwd: repo.path }),
        onProgress,
        authentication,
        provider,
      ),
    };
  }
  remotes(id: string, signal?: AbortSignal) {
    const { repo, manager } = this.remoteManager(id);
    return this.queue(repo.commonDir).run(false, () => manager.state(signal), signal);
  }
  providerRemoteTarget(
    id: string,
    name: string,
    direction: 'fetch' | 'push',
    signal?: AbortSignal,
  ) {
    const { repo, manager } = this.remoteManager(id);
    return this.queue(repo.commonDir).run(
      false,
      () => manager.providerTarget(name, direction, signal),
      signal,
    );
  }
  deleteRemotePreview(
    id: string,
    selection: DeleteRemoteSelection,
    signal?: AbortSignal,
    onProgress?: (text: string) => void,
    authentication?: NodeJS.ProcessEnv,
    provider?: ProviderRemoteAuthorization,
  ) {
    const { repo, manager } = this.remoteManager(id, onProgress, authentication, provider);
    return this.queue(repo.commonDir).run(
      false,
      () => manager.deletePreview(selection, signal),
      signal,
    );
  }
  deleteRemote(
    id: string,
    plan: DeleteRemotePlan,
    signal?: AbortSignal,
    onProgress?: (text: string) => void,
    authentication?: NodeJS.ProcessEnv,
    provider?: ProviderRemoteAuthorization,
  ) {
    const { repo, manager } = this.remoteManager(id, onProgress, authentication, provider);
    return this.queue(repo.commonDir).run(true, () => manager.delete(plan, signal), signal);
  }
  pushPreview(
    id: string,
    selection: PushSelection,
    signal?: AbortSignal,
    onProgress?: (text: string) => void,
    authentication?: NodeJS.ProcessEnv,
    provider?: ProviderRemoteAuthorization,
  ) {
    const { repo, manager } = this.remoteManager(id, onProgress, authentication, provider);
    return this.queue(repo.commonDir).run(
      false,
      () => manager.pushPreview(selection, signal),
      signal,
    );
  }
  push(
    id: string,
    options: PushOptions,
    signal?: AbortSignal,
    onProgress?: (text: string) => void,
    authentication?: NodeJS.ProcessEnv,
    provider?: ProviderRemoteAuthorization,
  ) {
    const { repo, manager } = this.remoteManager(id, onProgress, authentication, provider);
    return this.queue(repo.commonDir).run(true, () => manager.push(options, signal), signal);
  }
  conflictPreview(id: string, pathBytes: string, signal?: AbortSignal) {
    const work = this.working(id);
    return this.queue(work.repo.commonDir).run(
      false,
      () => work.conflictPreview(pathBytes, signal),
      signal,
    );
  }
  resolveConflict(id: string, options: ResolveConflict, signal?: AbortSignal) {
    const work = this.working(id);
    return this.queue(work.repo.commonDir).run(
      true,
      () => work.resolveConflict(options, signal),
      signal,
    );
  }
  mergePrediction(id: string, head: string, target: string, signal?: AbortSignal) {
    const repo = this.repositories.get(id);
    if (!repo) throw new GitError('UNKNOWN_REPOSITORY', 'Open this repository first');
    return this.queue(repo.commonDir).run(
      false,
      () =>
        predictMerge(
          (args, options) => this.run(args, { cwd: repo.path, ...options }),
          head,
          target,
          signal,
        ),
      signal,
    );
  }
  commitFiles(id: string, oid: string, parent?: string, signal?: AbortSignal) {
    const repo = this.repositories.get(id);
    if (!repo) throw new GitError('UNKNOWN_REPOSITORY', 'Open this repository first');
    return this.queue(repo.commonDir).run(
      false,
      () =>
        commitFiles(
          (args, options) => this.run(args, { cwd: repo.path, ...options }),
          oid,
          parent,
          signal,
        ),
      signal,
    );
  }
  commitComparison(id: string, options: CommitComparisonOptions, signal?: AbortSignal) {
    const repo = this.repositories.get(id);
    if (!repo) throw new GitError('UNKNOWN_REPOSITORY', 'Open this repository first');
    return this.queue(repo.commonDir).run(
      false,
      () =>
        commitComparison(
          (args, options) => this.run(args, { cwd: repo.path, ...options }),
          options,
          signal,
        ),
      signal,
    );
  }
  fileHistory(id: string, options: FileHistoryOptions, signal?: AbortSignal) {
    const repo = this.repositories.get(id);
    if (!repo) throw new GitError('UNKNOWN_REPOSITORY', 'Open this repository first');
    return this.queue(repo.commonDir).run(
      false,
      () =>
        fileHistory(
          (args, settings) => this.run(args, { cwd: repo.path, ...settings }),
          options,
          signal,
        ),
      signal,
    );
  }
  blame(
    id: string,
    options: BlameOptions,
    signal: AbortSignal | undefined,
    onLines: (lines: BlameLine[]) => void,
  ) {
    const repo = this.repositories.get(id);
    if (!repo) throw new GitError('UNKNOWN_REPOSITORY', 'Open this repository first');
    return this.queue(repo.commonDir).run(
      false,
      () =>
        blame(
          (args, settings) => this.run(args, { cwd: repo.path, ...settings }),
          options,
          signal,
          onLines,
        ),
      signal,
    );
  }
  resetPreview(id: string, selection: ResetSelection, signal?: AbortSignal) {
    const work = this.working(id);
    return this.queue(work.repo.commonDir).run(
      false,
      () => work.resetPreview(selection, signal),
      signal,
    );
  }
  reset(id: string, selection: ResetSelection, token: string, signal?: AbortSignal) {
    const work = this.working(id);
    return this.queue(work.repo.commonDir).run(
      true,
      () => work.reset(selection, token, signal),
      signal,
    );
  }
  startOperation(
    id: string,
    options: StartOperation,
    signal?: AbortSignal,
    onProgress?: (text: string) => void,
  ) {
    const work = this.working(id);
    return this.queue(work.repo.commonDir).run(
      true,
      () => work.startOperation(options, signal, onProgress),
      signal,
    );
  }
  interactiveRebasePreview(id: string, base: string, signal?: AbortSignal) {
    const work = this.working(id);
    return this.queue(work.repo.commonDir).run(
      false,
      () => work.interactiveRebasePreview(base, signal),
      signal,
    );
  }
  interactiveRebase(
    id: string,
    options: InteractiveRebase,
    signal?: AbortSignal,
    onProgress?: (text: string) => void,
    edit?: GitEditor,
  ) {
    const work = this.working(id);
    return this.queue(work.repo.commonDir).run(
      true,
      () => work.interactiveRebase(options, signal, onProgress, edit),
      signal,
    );
  }
  operationAction(
    id: string,
    options: OperationAction,
    signal?: AbortSignal,
    onProgress?: (text: string) => void,
    edit?: GitEditor,
  ) {
    const work = this.working(id);
    return this.queue(work.repo.commonDir).run(
      true,
      () => work.operationAction(options, signal, onProgress, edit),
      signal,
    );
  }
  operationState(id: string, signal?: AbortSignal) {
    const work = this.working(id);
    return this.queue(work.repo.commonDir).run(false, () => work.operationState(signal), signal);
  }
  providerPullPreview(id: string, options: PullOptions, signal?: AbortSignal) {
    const work = this.working(id);
    const { repo, manager } = this.remoteManager(id);
    return this.queue(repo.commonDir).run(
      false,
      async () => {
        const context = await work.pullContext(options, signal);
        if (context.remote === '.')
          throw new GitError(
            'PROVIDER_PULL_LOCAL',
            'This upstream is local. Use Git credential helpers for this pull.',
          );
        const target = await manager.providerTarget(context.remote, 'fetch', signal);
        if (JSON.stringify(await work.pullContext(options, signal)) !== JSON.stringify(context))
          throw new GitError(
            'STALE_PULL',
            'The branch or upstream changed during review. Review the pull again.',
          );
        return { target, upstream: context.upstream };
      },
      signal,
    );
  }
  pull(
    id: string,
    options: PullOptions,
    signal?: AbortSignal,
    onProgress?: (text: string) => void,
    authentication?: NodeJS.ProcessEnv,
    provider?: ProviderRemoteAuthorization,
  ) {
    const work = this.working(id);
    const { repo, manager } = this.remoteManager(id, onProgress, authentication, provider);
    return this.queue(repo.commonDir).run(
      true,
      async () => {
        const context = await work.pullContext(options, signal);
        if (provider && context.remote === '.')
          throw new GitError(
            'PROVIDER_PULL_LOCAL',
            'This upstream is local. Use Git credential helpers for this pull.',
          );
        if (context.remote !== '.') await manager.fetch(context.remote, signal);
        return work
          .integratePull(options, context, signal, onProgress, authentication, provider)
          .catch((error: unknown) => {
            if (error instanceof GitError) throw transportError(error);
            throw error;
          });
      },
      signal,
    );
  }
  fetch(
    id: string,
    name: string,
    signal?: AbortSignal,
    background = false,
    onProgress?: (text: string) => void,
    authentication?: NodeJS.ProcessEnv,
    provider?: ProviderRemoteAuthorization,
  ) {
    const { repo, manager } = this.remoteManager(id, onProgress, authentication, provider);
    return this.queue(repo.commonDir).run(
      true,
      () => manager.fetch(name, signal, background),
      signal,
    );
  }
  remote(id: string, options: RemoteOptions, signal?: AbortSignal) {
    const { repo, manager } = this.remoteManager(id);
    return this.queue(repo.commonDir).run(true, () => manager.change(options, signal), signal);
  }
  stashAction(id: string, options: StashActionOptions, signal?: AbortSignal) {
    const work = this.working(id);
    return this.queue(work.repo.commonDir).run(
      true,
      () => work.stashAction(options, signal),
      signal,
    );
  }
  stashes(id: string, signal?: AbortSignal) {
    const work = this.working(id);
    return this.queue(work.repo.commonDir).run(false, () => work.stashes(signal), signal);
  }
  private worktreeManager(id: string) {
    const repo = this.repositories.get(id);
    if (!repo) throw new GitError('UNKNOWN_REPOSITORY', 'Open this repository first');
    return {
      repo,
      manager: new Worktrees(repo, (args, options) => this.run(args, options), this.worktreePrunes),
    };
  }
  private submoduleManager(id: string) {
    const repo = this.repositories.get(id);
    if (!repo) throw new GitError('UNKNOWN_REPOSITORY', 'Open this repository first');
    return { repo, manager: new Submodules(repo, (args, options) => this.run(args, options)) };
  }
  lfsState(id: string, signal?: AbortSignal) {
    const repo = this.repositories.get(id);
    if (!repo) throw new GitError('UNKNOWN_REPOSITORY', 'Open this repository first');
    return this.queue(repo.commonDir).run(
      false,
      () => lfsState((args, options) => this.run(args, { ...options, cwd: repo.path }), signal),
      signal,
    );
  }
  private lfsTransfers(id: string) {
    const repo = this.repositories.get(id);
    if (!repo) throw new GitError('UNKNOWN_REPOSITORY', 'Open this repository first');
    return {
      repo,
      manager: new LfsTransfers(
        repo,
        (args, options) => this.run(args, { ...options, cwd: repo.path }),
        this.lfsPullPlans,
      ),
    };
  }
  private lfsInstaller(id: string) {
    const repo = this.repositories.get(id);
    if (!repo) throw new GitError('UNKNOWN_REPOSITORY', 'Open this repository first');
    return {
      repo,
      manager: new LfsSetup(
        repo,
        (args, options) => this.run(args, { ...options, cwd: repo.path }),
        this.lfsSetupPlans,
      ),
    };
  }
  lfsSetupPreview(id: string, skipSmudge: boolean, signal?: AbortSignal) {
    const { repo, manager } = this.lfsInstaller(id);
    return this.queue(repo.commonDir).run(false, () => manager.preview(skipSmudge, signal), signal);
  }
  lfsSetup(id: string, token: string, signal?: AbortSignal) {
    const { repo, manager } = this.lfsInstaller(id);
    return this.queue(repo.commonDir).run(true, () => manager.install(token, signal), signal);
  }
  lfsLocks(id: string, remote: string, signal?: AbortSignal, authentication?: NodeJS.ProcessEnv) {
    const { repo, manager } = this.lfsTransfers(id);
    // Serialize native LFS network commands and any local metadata they may write.
    return this.queue(repo.commonDir).run(
      true,
      () => manager.locks(remote, signal, authentication),
      signal,
    );
  }
  lfsPullPreview(id: string, remote: string, signal?: AbortSignal) {
    const { repo, manager } = this.lfsTransfers(id);
    return this.queue(repo.commonDir).run(false, () => manager.preview(remote, signal), signal);
  }
  lfsPull(
    id: string,
    token: string,
    signal?: AbortSignal,
    progress?: (text: string) => void,
    authentication?: NodeJS.ProcessEnv,
  ) {
    const { repo, manager } = this.lfsTransfers(id);
    return this.queue(repo.commonDir).run(
      true,
      () => manager.pull(token, signal, progress, authentication),
      signal,
    );
  }
  submodules(id: string, signal?: AbortSignal) {
    const { repo, manager } = this.submoduleManager(id);
    return this.queue(repo.commonDir).run(false, () => manager.list(signal), signal);
  }
  submoduleSyncPreview(id: string, signal?: AbortSignal) {
    const { repo } = this.submoduleManager(id);
    const manager = new SubmoduleSync(
      repo,
      (args, options) => this.run(args, options),
      this.submoduleSyncPlans,
    );
    return this.queue(repo.commonDir).run(false, () => manager.preview(signal), signal);
  }
  syncSubmodules(id: string, token: string, signal?: AbortSignal) {
    const { repo } = this.submoduleManager(id);
    const manager = new SubmoduleSync(
      repo,
      (args, options) => this.run(args, options),
      this.submoduleSyncPlans,
    );
    return this.queue(repo.commonDir).run(true, () => manager.sync(token, signal), signal);
  }
  submoduleUpdatePreview(id: string, signal?: AbortSignal) {
    const { repo } = this.submoduleManager(id);
    const manager = new SubmoduleUpdates(
      repo,
      (args, options) => this.run(args, options),
      this.submoduleUpdates,
    );
    return this.queue(repo.commonDir).run(false, () => manager.preview(signal), signal);
  }
  updateSubmodules(
    id: string,
    token: string,
    allowLocal: boolean,
    signal?: AbortSignal,
    progress?: (text: string) => void,
    authentication?: NodeJS.ProcessEnv,
  ) {
    const { repo } = this.submoduleManager(id);
    const manager = new SubmoduleUpdates(
      repo,
      (args, options) => this.run(args, options),
      this.submoduleUpdates,
    );
    return this.queue(repo.commonDir).run(
      true,
      () => manager.update(token, allowLocal, signal, progress, authentication),
      signal,
    );
  }
  openSubmodule(id: string, submoduleId: string, revision: string, signal?: AbortSignal) {
    const { repo, manager } = this.submoduleManager(id);
    return this.queue(repo.commonDir).run(
      false,
      async () => {
        const selected = await manager.select(submoduleId, revision, signal);
        const opened = await this.open(selected.path, signal);
        if (opened.path !== selected.path || opened.gitDir !== selected.gitDir)
          throw new GitError('SUBMODULE_REPLACED', 'Submodule checkout changed before opening');
        return opened;
      },
      signal,
    );
  }
  worktrees(id: string, signal?: AbortSignal) {
    const { repo, manager } = this.worktreeManager(id);
    return this.queue(repo.commonDir).run(false, () => manager.list(signal), signal);
  }
  addWorktree(id: string, path: string, options: WorktreeAdd, signal?: AbortSignal) {
    const { repo, manager } = this.worktreeManager(id);
    return this.queue(repo.commonDir).run(true, () => manager.add(path, options, signal), signal);
  }
  worktreeAction(id: string, options: WorktreeAction, signal?: AbortSignal) {
    const { repo, manager } = this.worktreeManager(id);
    return this.queue(repo.commonDir).run(true, () => manager.action(options, signal), signal);
  }
  worktreePrunePreview(id: string, signal?: AbortSignal) {
    const { repo, manager } = this.worktreeManager(id);
    return this.queue(repo.commonDir).run(false, () => manager.previewPrune(signal), signal);
  }
  pruneWorktrees(id: string, token: string, signal?: AbortSignal) {
    const { repo, manager } = this.worktreeManager(id);
    return this.queue(repo.commonDir).run(true, () => manager.prune(token, signal), signal);
  }
  openWorktree(id: string, worktreeId: string, revision: string, signal?: AbortSignal) {
    const { repo, manager } = this.worktreeManager(id);
    return this.queue(repo.commonDir).run(
      false,
      async () => {
        const entry = await manager.select(worktreeId, revision, signal);
        const opened = await this.open(entry.path, signal);
        if (opened.commonDir !== repo.commonDir)
          throw new GitError('WORKTREE_REPLACED', 'This folder belongs to another repository');
        return opened;
      },
      signal,
    );
  }
  stashPush(id: string, options: StashPushOptions, signal?: AbortSignal) {
    const work = this.working(id);
    return this.queue(work.repo.commonDir).run(true, () => work.stashPush(options, signal), signal);
  }
  reference(id: string, options: ReferenceOptions, signal?: AbortSignal) {
    const work = this.working(id);
    return this.queue(work.repo.commonDir).run(true, () => work.reference(options, signal), signal);
  }
  workingState(id: string, signal?: AbortSignal) {
    const work = this.working(id);
    return this.queue(work.repo.commonDir).run(false, () => work.state(signal), signal);
  }
  files(id: string, action: 'stage' | 'unstage', paths: string[], signal?: AbortSignal) {
    const work = this.working(id);
    return this.queue(work.repo.commonDir).run(
      true,
      () => work.files(action, paths, signal),
      signal,
    );
  }
  workingComparison(id: string, options: WorkingComparisonOptions, signal?: AbortSignal) {
    const work = this.working(id);
    return this.queue(work.repo.commonDir).run(
      false,
      () => work.workingComparison(options, signal),
      signal,
    );
  }
  workingFile(id: string, options: WorkingFileOptions, signal?: AbortSignal) {
    const work = this.working(id);
    return this.queue(work.repo.commonDir).run(
      false,
      () => work.workingFile(options, signal),
      signal,
    );
  }
  saveWorkingFile(id: string, options: SaveWorkingFile, signal?: AbortSignal) {
    const work = this.working(id);
    return this.queue(work.repo.commonDir).run(
      true,
      () => work.saveWorkingFile(options, signal),
      signal,
    );
  }
  diff(id: string, pathBytes: string, side: 'worktree' | 'index', signal?: AbortSignal) {
    const work = this.working(id);
    return this.queue(work.repo.commonDir).run(
      false,
      () => work.diff(pathBytes, side, signal),
      signal,
    );
  }
  patch(id: string, options: PatchOptions, signal?: AbortSignal) {
    const work = this.working(id);
    return this.queue(work.repo.commonDir).run(true, () => work.patch(options, signal), signal);
  }
  discardPreview(id: string, paths: string[], signal?: AbortSignal) {
    const work = this.working(id);
    return this.queue(work.repo.commonDir).run(
      false,
      () => work.discardPreview(paths, signal),
      signal,
    );
  }
  discard(id: string, paths: string[], token: string, signal?: AbortSignal) {
    const work = this.working(id);
    return this.queue(work.repo.commonDir).run(
      true,
      () => work.discard(paths, token, signal),
      signal,
    );
  }
  commit(id: string, options: CommitOptions, signal?: AbortSignal) {
    const work = this.working(id);
    return this.queue(work.repo.commonDir).run(true, () => work.commit(options, signal), signal);
  }
  undo(id: string, redo = false, signal?: AbortSignal) {
    const work = this.working(id);
    return this.queue(work.repo.commonDir).run(true, () => work.undo(redo, signal), signal);
  }
  async dispose() {
    this.cache?.stopReadingTails();
    this.worktreePrunes.clear();
    this.submoduleUpdates.clear();
    this.submoduleSyncPlans.clear();
    this.lfsPullPlans.clear();
    this.lfsSetupPlans.clear();
    await Promise.all([...this.histories.values()].map((cursor) => cursor.close()));
    this.histories.clear();
    await this.cache?.flush();
  }
}
