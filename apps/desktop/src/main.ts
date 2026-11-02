import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  utilityProcess,
  session,
  safeStorage,
  shell,
} from 'electron';
import type { IpcMainInvokeEvent, UtilityProcess } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CHANNEL,
  CANCEL_CHANNEL,
  EVENT_CHANNEL,
  desktopEventSchema,
  requestSchema,
  cancelSchema,
  serviceResponseSchema,
  providerAccountsSchema,
  deviceChallengeSchema,
  resultSchema,
} from '@openkraken/ipc-contract';
import type { Result, ServiceRequest } from '@openkraken/ipc-contract';
import { AvatarCache } from './avatars.js';
import { fetchAvatar } from './avatar-provider.js';
import { isTrustedDocument, windowPreferences } from './security.js';
import { ProviderService } from './providers.js';
import { GitHubProvider, ProviderError } from './github-provider.js';
import { GitHubOAuth } from './github-device.js';
import {
  ProviderVault,
  ProviderCredentialError,
  electronSecretProtection,
} from './provider-vault.js';
const htmlPath = join(__dirname, 'renderer', 'index.html');
const documentUrl = pathToFileURL(htmlPath).href;
let window: BrowserWindow | undefined;
let service: UtilityProcess | undefined;
let avatars: AvatarCache | undefined;
let providers: ProviderService | undefined;
const providerRequests = new Map<string, AbortController>();
const pending = new Map<
  string,
  { resolve: (result: Result) => void; timer: ReturnType<typeof setTimeout> }
>();
const inFlight = new Set<string>();
const cancelled = new Set<string>();
function getProviders() {
  const fetchProvider: typeof fetch = (input, init) =>
    session
      .fromPartition('openkraken-providers')
      .fetch(input instanceof Request ? input.url : String(input), init);
  return (providers ??= new ProviderService(
    app.getPath('userData'),
    new ProviderVault(app.getPath('userData'), electronSecretProtection(safeStorage)),
    new GitHubProvider(fetchProvider),
    new GitHubOAuth(fetchProvider),
  ));
}
function startService() {
  const child = utilityProcess.fork(join(__dirname, 'git-service.cjs'), [app.getPath('userData')], {
    serviceName: 'OpenKraken Git',
    stdio: 'pipe',
  });
  service = child;
  child.on('message', (message) => {
    const event = desktopEventSchema.safeParse(message);
    if (event.success) {
      if (event.data.type !== 'repositoryChanged' && !pending.has(event.data.id)) return;
      if (service === child && window && !window.isDestroyed())
        window.webContents.send(EVENT_CHANNEL, event.data);
      return;
    }
    const parsed = serviceResponseSchema.safeParse(message);
    if (!parsed.success) return;
    const request = pending.get(parsed.data.id);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(parsed.data.id);
    request.resolve(parsed.data.result);
  });
  child.on('exit', () => {
    if (service === child) service = undefined;
    for (const [id, request] of pending) {
      clearTimeout(request.timer);
      request.resolve({
        kind: 'error',
        code: 'SERVICE_EXIT',
        message: 'The Git service stopped. Retry the operation.',
      });
      pending.delete(id);
    }
  });
  return child;
}
function callService(request: ServiceRequest, signal?: AbortSignal): Promise<Result> {
  if (signal?.aborted) return Promise.resolve({ kind: 'cancelled' });
  const child = service ?? startService();
  const cancel = () => child.postMessage({ id: request.id });
  signal?.addEventListener('abort', cancel, { once: true });
  return new Promise<Result>((resolve) => {
    const timer = setTimeout(
      () => {
        child.postMessage({ id: request.id });
        pending.delete(request.id);
        resolve({
          kind: 'error',
          code: 'SERVICE_TIMEOUT',
          message: 'The Git service did not respond in time.',
        });
      },
      request.method === 'clone' || request.method === 'resolveConflict'
        ? 1860000
        : request.method === 'pull'
          ? 390000
          : [
                'fetch',
                'pushPreview',
                'push',
                'deleteRemote',
                'deleteRemotePreview',
                'operationAction',
                'startOperation',
                'interactiveRebase',
                'reset',
              ].includes(request.method)
            ? 210000
            : request.method === 'commit' || request.method === 'reference'
              ? 180000
              : 60000,
    );
    pending.set(request.id, { resolve, timer });
    child.postMessage(request);
  }).finally(() => signal?.removeEventListener('abort', cancel));
}
function validateSender(event: IpcMainInvokeEvent) {
  if (
    !window ||
    event.sender !== window.webContents ||
    !isTrustedDocument(event.senderFrame, documentUrl, event.senderFrame === event.sender.mainFrame)
  )
    throw new Error('Untrusted IPC sender');
}
function createWindow() {
  window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'OpenKraken',
    backgroundColor: '#10151e',
    webPreferences: { ...windowPreferences, preload: join(__dirname, 'preload.cjs') },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-prevent-unload', (event) => {
    if (!window || window.isDestroyed()) return;
    const choice = dialog.showMessageBoxSync(window, {
      type: 'question',
      buttons: ['Keep editing', 'Discard changes'],
      defaultId: 0,
      cancelId: 0,
      title: 'Unsaved changes',
      message: 'Discard unsaved changes?',
      detail: 'Your editor draft has not been saved to disk.',
      noLink: true,
    });
    if (choice === 1) event.preventDefault();
  });
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.on('closed', () => {
    window = undefined;
    for (const id of pending.keys()) service?.postMessage({ id });
    for (const controller of providerRequests.values()) controller.abort();
    providers?.deviceCancel();
  });
  void window.loadFile(htmlPath);
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    );
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      callback({
        cancel: !details.url.startsWith(pathToFileURL(join(__dirname, 'renderer') + '/').href),
      });
    });
    ipcMain.handle(CHANNEL, async (event, raw): Promise<Result> => {
      validateSender(event);
      const request = requestSchema.parse(raw);
      if (inFlight.has(request.id))
        return { kind: 'error', code: 'DUPLICATE_REQUEST', message: 'Request is already running' };
      if (inFlight.size >= 8)
        return { kind: 'error', code: 'BUSY', message: 'Too many pending operations' };
      inFlight.add(request.id);
      try {
        if (request.method === 'providerGit') {
          const controller = new AbortController();
          providerRequests.set(request.id, controller);
          const target = await callService(
            { id: crypto.randomUUID(), method: 'providerGitTarget', operation: request.operation },
            controller.signal,
          );
          if (target.kind === 'error' || target.kind === 'cancelled') return target;
          if (target.kind !== 'providerGitTarget')
            throw new ProviderError('PROVIDER_REMOTE', 'The remote could not be resolved.');
          if (
            target.target.token !==
            (request.operation.method === 'push'
              ? request.operation.options.plan.token
              : request.operation.method === 'deleteRemote'
                ? request.operation.plan.token
                : request.operation.revision)
          )
            throw new ProviderError(
              'STALE_PROVIDER_REMOTE',
              'The remote configuration or tracking refs changed. Reload remotes before retrying.',
            );
          const credential = await getProviders().gitCredential(
            request.accountId,
            target.target.url,
            controller.signal,
          );
          controller.signal.throwIfAborted();
          return await callService(
            {
              id: request.id,
              method: 'providerGit',
              operation: request.operation,
              token: target.target.token,
              credential,
            },
            controller.signal,
          );
        }
        if (
          request.method === 'providerPullComments' ||
          request.method === 'providerCreateComment' ||
          request.method === 'providerPullFiles' ||
          request.method === 'providerPullReviews' ||
          request.method === 'providerSubmitReview' ||
          request.method === 'providerPullRequests' ||
          request.method === 'providerPullRequest' ||
          request.method === 'providerRepositories' ||
          request.method === 'providerAccounts' ||
          request.method === 'providerConnect' ||
          request.method === 'providerDisconnect' ||
          request.method === 'providerVerify' ||
          request.method === 'providerDeviceStart' ||
          request.method === 'providerDevicePoll' ||
          request.method === 'providerDeviceCancel' ||
          request.method === 'providerDeviceOpen'
        ) {
          providers = getProviders();
          const controller = new AbortController();
          providerRequests.set(request.id, controller);
          if (request.method === 'providerPullComments')
            return resultSchema.parse({
              kind: 'providerPullComments',
              page: await providers.pullComments(
                request.accountId,
                request.options,
                controller.signal,
              ),
            });
          if (request.method === 'providerCreateComment')
            return resultSchema.parse({
              kind: 'providerCommentCreated',
              comment: await providers.createComment(
                request.accountId,
                request.options,
                controller.signal,
              ),
            });
          if (request.method === 'providerPullFiles')
            return resultSchema.parse({
              kind: 'providerPullFiles',
              page: await providers.pullFiles(
                request.accountId,
                request.options,
                controller.signal,
              ),
            });
          if (request.method === 'providerPullReviews')
            return resultSchema.parse({
              kind: 'providerPullReviews',
              page: await providers.pullReviews(
                request.accountId,
                request.options,
                controller.signal,
              ),
            });
          if (request.method === 'providerSubmitReview')
            return resultSchema.parse({
              kind: 'providerReviewSubmitted',
              review: await providers.submitReview(
                request.accountId,
                request.options,
                controller.signal,
              ),
            });
          if (request.method === 'providerPullRequests')
            return resultSchema.parse({
              kind: 'providerPullRequests',
              page: await providers.pullRequests(
                request.accountId,
                request.options,
                controller.signal,
              ),
            });
          if (request.method === 'providerPullRequest')
            return resultSchema.parse({
              kind: 'providerPullRequest',
              pullRequest: await providers.pullRequest(
                request.accountId,
                request.options,
                controller.signal,
              ),
            });
          if (request.method === 'providerRepositories')
            return resultSchema.parse({
              kind: 'providerRepositories',
              page: await providers.repositories(
                request.accountId,
                request.page,
                controller.signal,
              ),
            });
          if (request.method === 'providerDeviceStart')
            return {
              kind: 'providerDevice',
              challenge: deviceChallengeSchema.parse(
                await providers.deviceStart(request.options, controller.signal),
              ),
            };
          if (request.method === 'providerDevicePoll')
            return resultSchema.parse(
              await providers.devicePoll(request.challengeId, controller.signal),
            );
          if (request.method === 'providerDeviceCancel') {
            providers.deviceCancel(request.challengeId);
            return { kind: 'cancelled' };
          }
          if (request.method === 'providerDeviceOpen') {
            await shell.openExternal(providers.deviceVerificationUri(request.challengeId));
            return { kind: 'providerDeviceOpened' };
          }
          const state =
            request.method === 'providerAccounts'
              ? await providers.accounts()
              : request.method === 'providerConnect'
                ? await providers.connect(request.options, controller.signal)
                : request.method === 'providerVerify'
                  ? await providers.verify(request.accountId, controller.signal)
                  : await providers.disconnect(request.accountId);
          return { kind: 'providerAccounts', state: providerAccountsSchema.parse(state) };
        }
        avatars ??= new AvatarCache(app.getPath('userData'), fetchAvatar);
        if (request.method === 'appearance')
          return {
            kind: 'appearance',
            remoteAvatars: await avatars.appearance(request.remoteAvatars),
          };
        if (request.method === 'avatars')
          return { kind: 'avatars', images: await avatars.images(request.emails) };
        let path: string | undefined;
        if (
          request.method === 'open' ||
          request.method === 'init' ||
          request.method === 'clone' ||
          request.method === 'discover'
        ) {
          const selected = await dialog.showOpenDialog(window!, {
            title:
              request.method === 'clone'
                ? 'Clone into an empty folder'
                : request.method === 'init'
                  ? 'Initialize repository in folder'
                  : request.method === 'discover'
                    ? 'Scan for repositories'
                    : 'Open repository',
            properties: [
              'openDirectory',
              ...(['init', 'clone'].includes(request.method) ? ['createDirectory' as const] : []),
            ],
          });
          if (selected.canceled || !selected.filePaths[0] || cancelled.has(request.id))
            return { kind: 'cancelled' };
          path = selected.filePaths[0];
        }
        if (request.method === 'clone') {
          const controller = new AbortController();
          providerRequests.set(request.id, controller);
          const credential = request.providerAccountId
            ? await getProviders().gitCredential(
                request.providerAccountId,
                request.options.url,
                controller.signal,
              )
            : undefined;
          controller.signal.throwIfAborted();
          return await callService({
            id: request.id,
            method: 'clone',
            path: path!,
            options: request.options,
            ...(credential ? { credential } : {}),
          });
        }
        return await callService(
          request.method === 'open' || request.method === 'init' || request.method === 'discover'
            ? { ...request, path: path! }
            : request,
        );
      } catch (error) {
        if (
          request.method === 'providerGit' ||
          (request.method === 'clone' && !!request.providerAccountId) ||
          request.method === 'providerPullComments' ||
          request.method === 'providerCreateComment' ||
          request.method === 'providerPullFiles' ||
          request.method === 'providerPullReviews' ||
          request.method === 'providerSubmitReview' ||
          request.method === 'providerPullRequests' ||
          request.method === 'providerPullRequest' ||
          request.method === 'providerRepositories' ||
          request.method === 'providerAccounts' ||
          request.method === 'providerConnect' ||
          request.method === 'providerDisconnect' ||
          request.method === 'providerVerify' ||
          request.method === 'providerDeviceStart' ||
          request.method === 'providerDevicePoll' ||
          request.method === 'providerDeviceCancel' ||
          request.method === 'providerDeviceOpen'
        ) {
          if (
            (error instanceof ProviderError && error.code === 'CANCELLED') ||
            (error instanceof Error && error.name === 'AbortError')
          )
            return { kind: 'cancelled' };
          return {
            kind: 'error',
            code:
              error instanceof ProviderError || error instanceof ProviderCredentialError
                ? error.code
                : 'PROVIDER_REQUEST',
            message:
              error instanceof ProviderError || error instanceof ProviderCredentialError
                ? error.message
                : 'The provider account request could not be completed.',
          };
        }
        return {
          kind: 'error',
          code: 'REQUEST_FAILED',
          message: error instanceof Error ? error.message : String(error),
        };
      } finally {
        providerRequests.delete(request.id);
        inFlight.delete(request.id);
        cancelled.delete(request.id);
      }
    });
    ipcMain.handle(CANCEL_CHANNEL, (event, raw) => {
      validateSender(event);
      const { id } = cancelSchema.parse(raw);
      if (inFlight.has(id)) {
        cancelled.add(id);
        service?.postMessage({ id });
        providerRequests.get(id)?.abort();
      }
    });
    startService();
    createWindow();
    app.on('activate', () => {
      if (!window) createWindow();
    });
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  let quitting = false;
  // Keep the service and caches alive if a renderer cancels the window close.
  app.on('will-quit', (event) => {
    avatars?.close();
    providers?.deviceCancel();
    for (const controller of providerRequests.values()) controller.abort();
    if ((!service && !providers) || quitting) return;
    event.preventDefault();
    quitting = true;
    const child = service;
    const deadline = setTimeout(() => {
      child?.kill();
      app.quit();
    }, 1500);
    const stopped = child
      ? new Promise<void>((resolve) => child.once('exit', () => resolve()))
      : Promise.resolve();
    void Promise.all([stopped, providers?.idle()]).finally(() => {
      clearTimeout(deadline);
      app.quit();
    });
    child?.postMessage({ shutdown: true });
  });
}
