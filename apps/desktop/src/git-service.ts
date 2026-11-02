import { join } from 'node:path';
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
const authentication = new AskpassBroker(
  join(
    __dirname.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1'),
    'helpers',
    process.platform === 'win32' ? 'openkraken-askpass.exe' : 'openkraken-askpass',
  ),
  (event) => parent.postMessage(event),
);
let shuttingDown = false;
const active = new Map<string, AbortController>();
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
    return new RepositoryService(git.path, { dataDir: process.argv[2] });
  }));
}
async function execute(request: ServiceRequest, signal: AbortSignal): Promise<Result> {
  if (request.method === 'answerPrompt')
    return {
      kind: 'authenticationAnswered',
      accepted: authentication.answer(request.requestId, request.promptId, request.answer),
    };
  const interactive =
    request.method === 'clone' ||
    request.method === 'push' ||
    request.method === 'pull' ||
    request.method === 'deleteRemote' ||
    request.method === 'deleteRemotePreview' ||
    request.method === 'pushPreview' ||
    (request.method === 'fetch' && !request.background);
  const context =
    request.method === 'clone'
      ? `Clone ${request.options.url}`
      : request.method === 'fetch'
        ? `Fetch ${request.name}`
        : request.method === 'pull'
          ? 'Pull upstream'
          : request.method === 'deleteRemote' || request.method === 'deleteRemotePreview'
            ? 'Delete remote ref'
            : 'Push repository';
  const scope = interactive ? await authentication.open(request.id, context, signal) : undefined;
  try {
    return await executeGit(request, signal, scope?.environment);
  } finally {
    scope?.close();
  }
}
async function executeGit(
  request: Exclude<ServiceRequest, { method: 'answerPrompt' }>,
  signal: AbortSignal,
  auth?: NodeJS.ProcessEnv,
): Promise<Result> {
  const git = await getService();
  let lastProgress = 0;
  const progress = (text: string) => {
    const now = Date.now();
    if (now - lastProgress < 100) return;
    lastProgress = now;
    parent!.postMessage({ type: 'gitProgress', id: request.id, text });
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
    request.method === 'refresh'
      ? { id: request.repoId }
      : request.method === 'clone'
        ? await git.clone(request.path, request.options, signal, progress, auth)
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
    'files',
    'patch',
    'discard',
    'commit',
    'undo',
    'reference',
    'remote',
    'fetch',
    'push',
    'deleteRemote',
    'pull',
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
              message: error instanceof Error ? error.message : String(error),
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
