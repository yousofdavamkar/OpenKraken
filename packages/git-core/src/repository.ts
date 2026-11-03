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
  Snapshot,
} from '@openkraken/ipc-contract';
import { GitError, runGit, type RunOptions } from './runner.js';
import { HistoryParser, RefsParser, StatusParser, HISTORY_FORMAT, REF_FORMAT } from './parsers.js';
import { HistoryCache } from './history-cache.js';
import { RepositoryPreferences } from './preferences.js';
import { HistoryCursor } from './history.js';
import { Remotes } from './remotes.js';
import { predictMerge } from './merge-prediction.js';
import { commitFiles } from './commit-files.js';
import { blame } from './blame.js';
import { fileHistory } from './file-history.js';
import { commitComparison } from './file-comparison.js';
import { WorkingTree } from './working-tree.js';
import { Worktrees } from './worktrees.js';
import type { GitEditor } from './editor-document.js';
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
  private histories = new Map<string, HistoryCursor>();
  private processPool = new RepositoryQueue(3);
  private preferences: RepositoryPreferences;
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
    return result.stdout.toString('utf8').replace(/\r?\n$/, '');
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
  async snapshot(
    id: string,
    signal?: AbortSignal,
    refresh = true,
    requestedView?: GraphView,
  ): Promise<Snapshot> {
    const known = this.repositories.get(id);
    if (!known) throw new GitError('UNKNOWN_REPOSITORY', 'Open this repository first');
    const start = performance.now();
    return this.queue(known.commonDir).run(
      false,
      async () => {
        const view = requestedView ?? (await this.preferences.load(id));
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
        // Keep missing ref preferences: a deleted solo ref must not silently reveal all history.
        const visible = refs.filter((r) =>
          view.soloRef ? r.name === view.soloRef : !view.hiddenRefs.includes(r.name),
        );
        const pinned = visible.find(
          (r) =>
            r.name === view.pinnedRef &&
            r.kind !== 'stash' &&
            (r.objectType === 'commit' || r.peeledType === 'commit'),
        );
        // Filter non-commit tags. Explicit OIDs on stdin avoid ref/option ambiguity.
        const starts = new Set(
          visible
            .filter(
              (r) => r.kind !== 'stash' && (r.objectType === 'commit' || r.peeledType === 'commit'),
            )
            .map((r) => r.peeled ?? r.target),
        );
        const head = repository.head;
        if (
          head.oid &&
          !view.soloRef &&
          (head.kind === 'detached' || !view.hiddenRefs.includes(head.ref))
        )
          starts.add(head.oid);
        // Walk stash bases with normal history, but hide index/untracked parents.
        let stashCommits: Commit[] = [];
        if (visible.some((r) => r.kind === 'stash')) {
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
        await this.histories.get(id)?.close();
        // The current UI owns one active repository. Release inactive cursors on a switch.
        for (const [key, cursor] of this.histories)
          if (key !== id) {
            await cursor.close();
            this.histories.delete(key);
          }
        await this.cache?.flush();
        this.cache = undefined;
        if (
          this.dataDir &&
          !process.env.GIT_SHALLOW_FILE &&
          !process.env.GIT_REPLACE_REF_BASE &&
          !process.env.GIT_NO_REPLACE_OBJECTS
        ) {
          const [version, config, ...metadata] = await Promise.all([
            this.text(repository.path, ['--version'], signal),
            this.text(repository.path, ['config', '--null', '--list'], signal),
            ...['shallow', 'info/grafts', 'objects/info/alternates'].map((p) =>
              readFile(join(repository.commonDir, p))
                .then((b) => b.toString('base64'))
                .catch(() => ''),
            ),
            ...['objects/info/commit-graph', 'objects/info/commit-graphs/commit-graph-chain'].map(
              (p) =>
                stat(join(repository.commonDir, p))
                  .then((s) => `${s.size}:${s.mtimeMs}`)
                  .catch(() => ''),
            ),
          ]);
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
          this.cache = new HistoryCache(this.dataDir, id, key);
        }
        const seed = await this.cache?.load();
        const history = new HistoryCursor(
          this.git,
          repository.path,
          [...starts],
          stashCommits,
          seed,
        );
        this.histories.set(id, history);
        const page = await history.page(0, 2000, signal);
        this.cache?.record(0, page.commits, page.hasMore);
        if (requestedView) await this.preferences.save(id, requestedView);
        return {
          repository,
          view,
          pinnedOid: pinned ? (pinned.peeled ?? pinned.target) : undefined,
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
  async search(id: string, cursor: string, query: string, signal?: AbortSignal) {
    const history = this.history(id, cursor);
    const repo = this.repositories.get(id)!;
    const find = async (filter: string) => {
      const parser = new HistoryParser();
      if (history.starts.length)
        await this.run(
          [
            'log',
            '--date-order',
            '--max-count=101',
            '--regexp-ignore-case',
            '--fixed-strings',
            filter,
            `--format=commit %H%n${HISTORY_FORMAT}`,
            '--stdin',
          ],
          {
            cwd: repo.path,
            signal,
            stdin: history.starts.join('\n') + '\n',
            onStdout: (b) => parser.push(b),
          },
        );
      return parser.finish();
    };
    const [messages, authors] = await Promise.all([
      find(`--grep=${query}`),
      find(`--author=${query}`),
    ]);
    const queryLower = query.toLocaleLowerCase();
    const stashes = history.stashes.filter((c) =>
      [c.body, c.author.name, c.author.email, c.oid].some((value) =>
        value.toLocaleLowerCase().includes(queryLower),
      ),
    );
    let commits = [
      ...new Map([...stashes, ...messages, ...authors].map((c) => [c.oid, c])).values(),
    ];
    if (/^[0-9a-f]{7,64}$/i.test(query)) {
      const resolved = await this.text(
        repo.path,
        ['rev-parse', '--verify', '--quiet', '--end-of-options', `${query}^{commit}`],
        signal,
        [0, 1],
      );
      // Hash lookup must obey the same traversal as message/author search.
      let reachable = false;
      if (resolved)
        for (const tip of history.starts) {
          const result = await this.run(['merge-base', '--is-ancestor', resolved, tip], {
            cwd: repo.path,
            signal,
            allowedExitCodes: [0, 1],
          });
          if (result.exitCode === 0) {
            reachable = true;
            break;
          }
        }
      if (reachable) {
        const parser = new HistoryParser();
        await this.run(['log', '-1', `--format=commit %H%n${HISTORY_FORMAT}`, resolved, '--'], {
          cwd: repo.path,
          signal,
          onStdout: (b) => parser.push(b),
        });
        commits = [...new Map([...commits, ...parser.finish()].map((c) => [c.oid, c])).values()];
      }
    }
    this.history(id, cursor);
    commits.sort((a, b) => b.committer.time - a.committer.time);
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
        return work.integratePull(options, context, signal, onProgress);
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
    return { repo, manager: new Worktrees(repo, (args, options) => this.run(args, options)) };
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
    await Promise.all([...this.histories.values()].map((cursor) => cursor.close()));
    this.histories.clear();
    await this.cache?.flush();
  }
}
