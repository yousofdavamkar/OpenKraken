import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { serviceRequestSchema, shutdownSchema, cancelSchema } from '@openkraken/ipc-contract';
import type { Result, ServiceRequest, Repository } from '@openkraken/ipc-contract';
import {
  GitError,
  locateGit,
  RepositoryService,
  RepositoryWatcher,
  AskpassBroker,
} from '@openkraken/git-core';
const parent = process.parentPort;
if (!parent) throw new Error('Git service requires a parent port');
const editorHelper = join(
  __dirname.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1'),
  'helpers',
  process.platform === 'win32' ? 'openkraken-askpass.exe' : 'openkraken-askpass',
);
const authentication = new AskpassBroker(editorHelper, (event) => parent.postMessage(event));
let shuttingDown = false;
const active = new Map<string, AbortController>();
const editorPrompts = new Map<
  string,
  { requestId: string; finish: (text: string | null) => void }
>();
function reviewDocument(
  id: string,
  document: { path: string; text: string },
  signal: AbortSignal,
): Promise<string | null> {
  if (signal.aborted) return Promise.resolve(null);
  if (editorPrompts.size >= 8) throw new GitError('EDITOR_BUSY', 'Too many Git editor requests');
  return new Promise((resolve) => {
    const promptId = randomUUID();
    const cancel = () => finish(null);
    const finish = (text: string | null) => {
      if (!editorPrompts.delete(promptId)) return;
      signal.removeEventListener('abort', cancel);
      parent!.postMessage({ type: 'editorClosed', id, promptId });
      resolve(text);
    };
    editorPrompts.set(promptId, { requestId: id, finish });
    signal.addEventListener('abort', cancel, { once: true });
    parent!.postMessage({ type: 'editorPrompt', id, promptId, ...document });
  });
}
let service: Promise<RepositoryService> | undefined;
let gitPath = '';
let watcher: RepositoryWatcher | undefined;
let watchStart: ReturnType<typeof setTimeout> | undefined;
async function prepareWatcher(repo: Repository) {
  if (watcher?.repo.id === repo.id) return;
  clearTimeout(watchStart);
  await watcher?.close();
  watcher = new RepositoryWatcher(gitPath, repo, (event) =>
    parent!.postMessage({ type: 'repositoryChanged', ...event }),
  );
  // Establish a baseline before the snapshot, then subscribe after delivering history.
  await watcher.check();
}

function getService() {
  return (service ??= locateGit(process.env.OPENKRAKEN_GIT).then((git) => {
    gitPath = git.path;
    return new RepositoryService(git.path, { dataDir: process.argv[2], editorHelper });
  }));
}
async function execute(request: ServiceRequest, signal: AbortSignal): Promise<Result> {
  if (request.method === 'answerEditor') {
    const prompt = editorPrompts.get(request.promptId);
    const accepted = !!prompt && prompt.requestId === request.requestId;
    if (accepted) prompt!.finish(request.text);
    return { kind: 'editorAnswered', accepted };
  }
  if (request.method === 'answerPrompt')
    return {
      kind: 'authenticationAnswered',
      accepted: authentication.answer(request.requestId, request.promptId, request.answer),
    };
  const interactive =
    request.method === 'lfsLocks' ||
    request.method === 'lfsPull' ||
    request.method === 'updateSubmodules' ||
    request.method === 'providerGit' ||
    request.method === 'clone' ||
    request.method === 'push' ||
    request.method === 'pull' ||
    request.method === 'deleteRemote' ||
    request.method === 'deleteRemotePreview' ||
    request.method === 'pushPreview' ||
    (request.method === 'fetch' && !request.background);
  const context =
    request.method === 'lfsLocks'
      ? 'Refresh LFS server locks'
      : request.method === 'lfsPull'
        ? 'Download LFS objects'
        : request.method === 'updateSubmodules'
          ? 'Update submodules'
          : request.method === 'providerGit'
            ? request.operation.method === 'fetch'
              ? `Fetch ${request.operation.name}`
              : request.operation.method === 'pull'
                ? 'Pull upstream'
                : request.operation.method === 'deleteRemote' ||
                    request.operation.method === 'deleteRemotePreview'
                  ? 'Delete remote ref'
                  : 'Push repository'
            : request.method === 'clone'
              ? `Clone ${request.options.url}`
              : request.method === 'fetch'
                ? `Fetch ${request.name}`
                : request.method === 'pull'
                  ? 'Pull upstream'
                  : request.method === 'deleteRemote' || request.method === 'deleteRemotePreview'
                    ? 'Delete remote ref'
                    : 'Push repository';
  const scope = interactive
    ? await authentication.open(
        request.id,
        context,
        signal,
        request.method === 'clone' || request.method === 'providerGit'
          ? request.credential
          : undefined,
      )
    : undefined;
  try {
    return await executeGit(request, signal, scope?.environment);
  } finally {
    scope?.close();
  }
}
async function executeGit(
  request: Exclude<ServiceRequest, { method: 'answerPrompt' | 'answerEditor' }>,
  signal: AbortSignal,
  auth?: NodeJS.ProcessEnv,
): Promise<Result> {
  const git = await getService();
  let lastProgress = 0;
  const progress = (text: string) => {
    const now = Date.now();
    if (now - lastProgress < 100) return;
    lastProgress = now;
    if ((request.method === 'clone' && request.credential) || request.method === 'providerGit') {
      // Remote diagnostics are untrusted and may echo authentication material.
      const progress =
        /^(Receiving objects|Resolving deltas|Updating files|Checking out files|Writing objects|Counting objects|Compressing objects):\s+(\d{1,3})%/.exec(
          text,
        );
      text = progress
        ? `${progress[1]}: ${Math.min(100, Number(progress[2]))}%`
        : request.method === 'clone'
          ? 'Cloning provider repository…'
          : request.operation.method === 'push'
            ? 'Pushing provider repository…'
            : request.operation.method === 'pushPreview'
              ? 'Reviewing provider push…'
              : request.operation.method === 'pull'
                ? 'Pulling provider repository…'
                : request.operation.method === 'deleteRemote'
                  ? 'Deleting provider remote ref…'
                  : request.operation.method === 'deleteRemotePreview'
                    ? 'Reviewing provider remote deletion…'
                    : 'Fetching provider repository…';
    }
    parent!.postMessage({ type: 'gitProgress', id: request.id, text });
  };
  if (request.method === 'providerPullPreview')
    return {
      kind: 'providerPullPreview',
      ...(await git.providerPullPreview(request.repoId, request.options, signal)),
    };
  if (request.method === 'providerGitTarget') {
    const operation = request.operation;
    if (operation.method === 'pull') {
      const preview = await git.providerPullPreview(operation.repoId, operation.options, signal);
      return { kind: 'providerGitTarget', target: preview.target };
    }
    const name =
      operation.method === 'fetch'
        ? operation.name
        : operation.method === 'pushPreview' || operation.method === 'deleteRemotePreview'
          ? operation.selection.name
          : operation.method === 'deleteRemote'
            ? operation.plan.name
            : operation.options.plan.name;
    return {
      kind: 'providerGitTarget',
      target: await git.providerRemoteTarget(
        operation.repoId,
        name,
        operation.method === 'fetch' ? 'fetch' : 'push',
        signal,
      ),
    };
  }
  if (request.method === 'providerGit') {
    const operation = request.operation;
    const provider = {
      url: request.credential.url,
      username: request.credential.username,
      token: request.token,
    };
    if (operation.method === 'pull')
      return {
        kind: 'workingState',
        state: await git.pull(
          operation.repoId,
          operation.options,
          signal,
          progress,
          auth,
          provider,
        ),
      };
    if (operation.method === 'deleteRemotePreview')
      return {
        kind: 'deleteRemotePreview',
        plan: await git.deleteRemotePreview(
          operation.repoId,
          operation.selection,
          signal,
          progress,
          auth,
          provider,
        ),
      };
    if (operation.method === 'deleteRemote')
      return {
        kind: 'remotes',
        state: await git.deleteRemote(
          operation.repoId,
          operation.plan,
          signal,
          progress,
          auth,
          provider,
        ),
      };
    if (operation.method === 'pushPreview')
      return {
        kind: 'pushPreview',
        plan: await git.pushPreview(
          operation.repoId,
          operation.selection,
          signal,
          progress,
          auth,
          provider,
        ),
      };
    if (operation.method === 'push') {
      const result = await git.push(
        operation.repoId,
        operation.options,
        signal,
        progress,
        auth,
        provider,
      );
      return {
        kind: 'pushed',
        state: result.state,
        warning: result.warning
          ? 'Push completed, but upstream tracking could not be set. Set upstream after refreshing.'
          : undefined,
      };
    }
    return {
      kind: 'remotes',
      state: await git.fetch(
        operation.repoId,
        operation.name,
        signal,
        false,
        progress,
        auth,
        provider,
      ),
    };
  }
  if (request.method === 'commitComparison')
    return {
      kind: 'fileComparison',
      comparison: await git.commitComparison(request.repoId, request.options, signal),
    };
  if (request.method === 'blame')
    return {
      kind: 'blameComplete',
      ...(await git.blame(request.repoId, request.options, signal, (lines) =>
        parent!.postMessage({ type: 'blameLines', id: request.id, lines }),
      )),
    };
  if (request.method === 'workingComparison')
    return {
      kind: 'fileComparison',
      comparison: await git.workingComparison(request.repoId, request.options, signal),
    };
  if (request.method === 'workingFile')
    return {
      kind: 'workingFile',
      file: await git.workingFile(request.repoId, request.options, signal),
    };
  if (request.method === 'saveWorkingFile')
    return {
      kind: 'workingState',
      state: await git.saveWorkingFile(request.repoId, request.options, signal),
    };
  if (request.method === 'fileHistory')
    return {
      kind: 'fileHistory',
      page: await git.fileHistory(request.repoId, request.options, signal),
    };
  if (request.method === 'commitFiles')
    return {
      kind: 'commitFiles',
      files: await git.commitFiles(request.repoId, request.oid, request.parent, signal),
    };
  if (request.method === 'deleteRemotePreview')
    return {
      kind: 'deleteRemotePreview',
      plan: await git.deleteRemotePreview(
        request.repoId,
        request.selection,
        signal,
        progress,
        auth,
      ),
    };
  if (request.method === 'deleteRemote')
    return {
      kind: 'remotes',
      state: await git.deleteRemote(request.repoId, request.plan, signal, progress, auth),
    };
  if (request.method === 'pull')
    return {
      kind: 'workingState',
      state: await git.pull(request.repoId, request.options, signal, progress, auth),
    };
  if (request.method === 'stashAction')
    return {
      kind: 'stashAction',
      ...(await git.stashAction(request.repoId, request.options, signal)),
    };
  if (request.method === 'stashes')
    return { kind: 'stashes', state: await git.stashes(request.repoId, signal) };
  if (request.method === 'worktrees')
    return { kind: 'worktrees', state: await git.worktrees(request.repoId, signal) };
  if (request.method === 'lfsPullPreview')
    return {
      kind: 'lfsPullPreview',
      preview: await git.lfsPullPreview(request.repoId, request.remote, signal),
    };
  if (request.method === 'lfsSetupPreview')
    return {
      kind: 'lfsSetupPreview',
      preview: await git.lfsSetupPreview(request.repoId, request.skipSmudge, signal),
    };
  if (request.method === 'lfsSetup') {
    await git.lfsSetup(request.repoId, request.token, signal);
    return { kind: 'lfsInstalled' };
  }
  if (request.method === 'lfsPull')
    return {
      kind: 'lfsState',
      state: await git.lfsPull(request.repoId, request.token, signal, progress, auth),
    };
  if (request.method === 'lfsState')
    return { kind: 'lfsState', state: await git.lfsState(request.repoId, signal) };
  if (request.method === 'lfsLocks')
    return {
      kind: 'lfsLocks',
      state: await git.lfsLocks(request.repoId, request.remote, signal, auth),
    };
  if (request.method === 'submodules')
    return { kind: 'submodules', state: await git.submodules(request.repoId, signal) };
  if (request.method === 'submoduleSyncPreview')
    return {
      kind: 'submoduleSyncPreview',
      preview: await git.submoduleSyncPreview(request.repoId, signal),
    };
  if (request.method === 'syncSubmodules')
    return {
      kind: 'submodules',
      state: await git.syncSubmodules(request.repoId, request.token, signal),
    };
  if (request.method === 'submoduleUpdatePreview')
    return {
      kind: 'submoduleUpdatePreview',
      preview: await git.submoduleUpdatePreview(request.repoId, signal),
    };
  if (request.method === 'updateSubmodules')
    return {
      kind: 'submodules',
      state: await git.updateSubmodules(
        request.repoId,
        request.token,
        request.allowLocal,
        signal,
        progress,
        auth,
      ),
    };
  if (request.method === 'worktreePrunePreview')
    return {
      kind: 'worktreePrunePreview',
      preview: await git.worktreePrunePreview(request.repoId, signal),
    };
  if (request.method === 'pruneWorktrees')
    return {
      kind: 'worktrees',
      state: await git.pruneWorktrees(request.repoId, request.token, signal),
    };
  if (request.method === 'worktreeAction')
    return {
      kind: 'worktrees',
      state: await git.worktreeAction(request.repoId, request.options, signal),
    };
  if (request.method === 'addWorktree')
    return {
      kind: 'worktrees',
      state: await git.addWorktree(request.repoId, request.path, request.options, signal),
    };
  if (request.method === 'stashPush')
    return {
      kind: 'workingState',
      state: await git.stashPush(request.repoId, request.options, signal),
    };
  if (request.method === 'pushPreview')
    return {
      kind: 'pushPreview',
      plan: await git.pushPreview(request.repoId, request.selection, signal, progress, auth),
    };
  if (request.method === 'push')
    return {
      kind: 'pushed',
      ...(await git.push(request.repoId, request.options, signal, progress, auth)),
    };
  if (request.method === 'fetch')
    return {
      kind: 'remotes',
      state: await git.fetch(
        request.repoId,
        request.name,
        signal,
        request.background,
        progress,
        auth,
      ),
    };
  if (request.method === 'remotes')
    return { kind: 'remotes', state: await git.remotes(request.repoId, signal) };
  if (request.method === 'remote')
    return { kind: 'remotes', state: await git.remote(request.repoId, request.options, signal) };
  if (request.method === 'reference')
    return {
      kind: 'workingState',
      state: await git.reference(request.repoId, request.options, signal),
    };
  if (request.method === 'diff')
    return {
      kind: 'diff',
      diff: await git.diff(request.repoId, request.pathBytes, request.side, signal),
    };
  if (request.method === 'patch')
    return {
      kind: 'workingState',
      state: await git.patch(request.repoId, request.options, signal),
    };
  if (request.method === 'discardPreview')
    return {
      kind: 'discardPreview',
      preview: await git.discardPreview(request.repoId, request.paths, signal),
    };
  if (request.method === 'discard')
    return {
      kind: 'workingState',
      state: await git.discard(request.repoId, request.paths, request.token, signal),
    };
  if (request.method === 'commit')
    return {
      kind: 'workingState',
      state: await git.commit(request.repoId, request.options, signal),
    };
  if (request.method === 'conflictPreview')
    return {
      kind: 'conflictPreview',
      preview: await git.conflictPreview(request.repoId, request.pathBytes, signal),
    };
  if (request.method === 'resolveConflict')
    return {
      kind: 'workingState',
      state: await git.resolveConflict(request.repoId, request.options, signal),
    };
  if (request.method === 'mergePrediction')
    return {
      kind: 'mergePrediction',
      prediction: await git.mergePrediction(request.repoId, request.head, request.target, signal),
    };
  if (request.method === 'resetPreview')
    return {
      kind: 'resetPreview',
      preview: await git.resetPreview(request.repoId, request.selection, signal),
    };
  if (request.method === 'reset')
    return {
      kind: 'workingState',
      state: await git.reset(request.repoId, request.selection, request.token, signal),
    };
  if (request.method === 'startOperation')
    return {
      kind: 'workingState',
      state: await git.startOperation(request.repoId, request.options, signal, progress),
    };
  if (request.method === 'interactiveRebasePreview')
    return {
      kind: 'interactiveRebasePreview',
      preview: await git.interactiveRebasePreview(request.repoId, request.base, signal),
    };
  if (request.method === 'interactiveRebase')
    return {
      kind: 'workingState',
      state: await git.interactiveRebase(
        request.repoId,
        request.options,
        signal,
        progress,
        (document, editorSignal) => reviewDocument(request.id, document, editorSignal),
      ),
    };
  if (request.method === 'operationAction')
    return {
      kind: 'workingState',
      state: await git.operationAction(
        request.repoId,
        request.options,
        signal,
        progress,
        (document, editorSignal) => reviewDocument(request.id, document, editorSignal),
      ),
    };
  if (request.method === 'workingState')
    return { kind: 'workingState', state: await git.workingState(request.repoId, signal) };
  if (request.method === 'files')
    return {
      kind: 'workingState',
      state: await git.files(request.repoId, request.action, request.paths, signal),
    };
  if (request.method === 'undo')
    return { kind: 'workingState', state: await git.undo(request.repoId, request.redo, signal) };
  if (request.method === 'page')
    return {
      kind: 'page',
      ...(await git.page(request.repoId, request.cursor, request.offset, request.count, signal)),
    };
  if (request.method === 'search')
    return {
      kind: 'search',
      ...(await git.search(request.repoId, request.cursor, request.query, signal)),
    };
  if (request.method === 'discover')
    return { kind: 'discovery', paths: await git.discover(request.path, signal) };
  const repo =
    request.method === 'openSubmodule'
      ? await git.openSubmodule(request.repoId, request.submoduleId, request.revision, signal)
      : request.method === 'openWorktree'
        ? await git.openWorktree(request.repoId, request.worktreeId, request.revision, signal)
        : request.method === 'refresh'
          ? { id: request.repoId }
          : request.method === 'clone'
            ? await git.clone(
                request.path,
                request.options,
                signal,
                progress,
                auth,
                request.credential
                  ? { url: request.credential.url, username: request.credential.username }
                  : undefined,
              )
            : request.method === 'init'
              ? await git.init(request.path, request.branch, signal)
              : await git.open(request.path, signal);
  if ('path' in repo) await prepareWatcher(repo);
  return {
    kind: 'snapshot',
    snapshot: await git.snapshot(
      repo.id,
      signal,
      request.method === 'refresh',
      request.method === 'refresh' ? request.view : undefined,
    ),
  };
}
parent.on('message', (event) => {
  if (shutdownSchema.safeParse(event.data).success) {
    shuttingDown = true;
    for (const controller of active.values()) controller.abort();
    if (!active.size) void shutdown();
    return;
  }
  if (shuttingDown) return;
  const cancel = cancelSchema.safeParse(event.data);
  if (cancel.success) {
    active.get(cancel.data.id)?.abort();
    return;
  }
  const parsed = serviceRequestSchema.safeParse(event.data);
  if (!parsed.success) return;
  const request = parsed.data;
  if (active.has(request.id)) return;
  const controller = new AbortController();
  active.set(request.id, controller);
  const writing = [
    'syncSubmodules',
    'lfsSetup',
    'lfsLocks',
    'lfsPull',
    'updateSubmodules',
    'addWorktree',
    'worktreeAction',
    'pruneWorktrees',
    'files',
    'patch',
    'discard',
    'commit',
    'undo',
    'reference',
    'remote',
    'fetch',
    'providerGit',
    'push',
    'deleteRemote',
    'pull',
    'operationAction',
    'startOperation',
    'interactiveRebase',
    'reset',
    'resolveConflict',
    'stashPush',
    'stashAction',
  ].includes(request.method);
  const observed = watcher;
  if (writing) observed?.pause();
  execute(request, controller.signal)
    .then((result) => {
      parent.postMessage({ id: request.id, result });
      if (result.kind === 'snapshot' && request.method !== 'refresh') {
        const current = watcher;
        clearTimeout(watchStart);
        watchStart = setTimeout(() => {
          if (!shuttingDown && watcher === current) void current?.start();
        }, 200);
      }
    })
    .catch((error: unknown) => {
      if (
        error instanceof GitError &&
        error.code === 'SSH_HOST_KEY_CHANGED' &&
        !(request.method === 'clone' && request.credential) &&
        request.method !== 'providerGit' &&
        !(request.method === 'fetch' && request.background)
      )
        parent.postMessage({
          type: 'transportProblem',
          id: request.id,
          code: error.code,
          message: error.message.slice(0, 8192),
        });
      const result: Result =
        error instanceof GitError && error.code === 'CANCELLED'
          ? { kind: 'cancelled' }
          : {
              kind: 'error',
              code: error instanceof GitError ? error.code : 'SERVICE_ERROR',
              message:
                (request.method === 'clone' && request.credential) ||
                request.method === 'providerGit'
                  ? providerGitFailure(
                      error,
                      request.method === 'providerGit' ? request.operation.method : 'clone',
                    )
                  : error instanceof Error
                    ? error.message
                    : String(error),
            };
      parent.postMessage({ id: request.id, result });
    })
    .finally(() => {
      if (writing) observed?.resume();
      controller.abort();
      active.delete(request.id);
      if (shuttingDown && !active.size) void shutdown();
    });
});

async function shutdown() {
  try {
    clearTimeout(watchStart);
    await authentication.close();
    await watcher?.close();
    await (await service)?.dispose();
  } finally {
    process.exit(0);
  }
}

function providerGitFailure(error: unknown, operation: string) {
  const messages: Record<string, string> = {
    PROVIDER_TRANSPORT_REWRITE:
      'Git rewrites this URL. Disable the rewrite or use Git credential helpers.',
    PUSH_REJECTED:
      operation === 'deleteRemote'
        ? 'Deletion rejected by the server. Check branch protections and review the destination before retrying.'
        : 'Push rejected by the server. Fetch and review the destination before retrying.',
    PUSH_LEASE_REJECTED:
      operation === 'deleteRemote'
        ? 'The destination changed since review. Review the deletion again before retrying.'
        : 'The destination changed since review. Review the push again before retrying.',
    STALE_REMOTE_DELETE:
      'The remote configuration or tracking refs changed. Review the deletion again.',
    REMOTE_REF_MISSING: 'That branch or tag does not exist at the push destination.',
    STALE_PUSH: 'The local tip or remote settings changed. Review the push again.',
    STALE_PROVIDER_REMOTE:
      'The remote configuration or tracking refs changed. Review the remote and retry.',
    CLONE_DESTINATION_NOT_EMPTY: 'Choose an empty folder for this clone.',
    TLS_CERTIFICATE_INVALID: 'The HTTPS certificate could not be verified.',
    STALE_PULL: 'The branch, staged files or upstream changed. Review the pull again.',
    PULL_DIRTY: 'Commit or stash tracked changes before pulling.',
    PULL_BRANCH_REQUIRED: 'Switch to an existing branch before pulling.',
    PULL_UPSTREAM_REQUIRED: 'Set an upstream for this branch before pulling.',
    PROVIDER_PULL_LOCAL: 'This upstream is local. Use Git credential helpers for this pull.',
  };
  return (
    (error instanceof GitError && messages[error.code]) ||
    (operation === 'pull'
      ? 'Pull did not complete. Check repository access and review the refreshed branch and any conflicts. Fast-forward-only refuses divergent history.'
      : 'Provider Git operation failed. Check repository access and HTTPS settings, or use Git credential helpers.')
  );
}
