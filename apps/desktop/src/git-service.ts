import { serviceRequestSchema, shutdownSchema, cancelSchema } from '@openkraken/ipc-contract';
import type { Result, ServiceRequest } from '@openkraken/ipc-contract';
import { GitError, locateGit, RepositoryService } from '@openkraken/git-core';
const parent = process.parentPort;
if (!parent) throw new Error('Git service requires a parent port');
let shuttingDown = false;
const active = new Map<string, AbortController>();
let service: Promise<RepositoryService> | undefined;
function getService() {
  return (service ??= locateGit(process.env.OPENKRAKEN_GIT).then(
    (git) => new RepositoryService(git.path, { dataDir: process.argv[2] }),
  ));
}
async function execute(request: ServiceRequest, signal: AbortSignal): Promise<Result> {
  const git = await getService();
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
      : request.method === 'init'
        ? await git.init(request.path, request.branch, signal)
        : await git.open(request.path, signal);
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
  execute(request, controller.signal)
    .then((result) => {
      parent.postMessage({ id: request.id, result });
    })
    .catch((error: unknown) => {
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
      controller.abort();
      active.delete(request.id);
      if (shuttingDown && !active.size) void shutdown();
    });
});

async function shutdown() {
  try {
    await (await service)?.dispose();
  } finally {
    process.exit(0);
  }
}
