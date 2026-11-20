import { MergeDrafts } from './merge-drafts.js';
import { PullDrafts } from './pull-drafts.js';
import { IssueDrafts } from './issue-drafts.js';
import { ReviewDrafts } from './review-drafts.js';
import { ActivityLog } from './activity-log.js';
import type { Diagnostics } from './diagnostics.js';
import { installTimeoutMs, Updates } from './updates.js';
import type { UpdateConfiguration } from './update-protocol.js';
import { appImageTarget } from './appimage-target.js';
import {
  prepareUpdateRestart,
  prepareUpdateLaunch,
  type PreparedUpdateLaunch,
} from './update-restart.js';
import { updatesStateSchema } from '@openkraken/ipc-contract';
import { RepositoryLinks } from './repository-links.js';
import { NativeEditorDrafts } from './native-editor-drafts.js';
import { WorkingFileDrafts } from './working-file-drafts.js';
import { CommitDrafts } from './commit-drafts.js';
import { CommandMenu } from './command-menu.js';
import { TerminalHost } from './terminal-host.js';
import { AppSettings } from './app-settings.js';
import type { CrashReports } from './crash-reports.js';
import { BitbucketProvider } from './bitbucket-provider.js';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  utilityProcess,
  session,
  safeStorage,
  nativeTheme,
  shell,
} from 'electron';
import type { IpcMainInvokeEvent, UtilityProcess } from 'electron';
import { extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CHANNEL,
  CANCEL_CHANNEL,
  validateResponseFormat,
  EVENT_CHANNEL,
  encodeHistoryPage,
  encodeSnapshotBodies,
  expandGitServiceResult,
  serializeLegacySnapshot,
  desktopEventSchema,
  editorWrittenSchema,
  requestSchema,
  cancelSchema,
  serviceResponseSchema,
  providerAccountsSchema,
  deviceChallengeSchema,
  resultSchema,
  nativeAppearanceMode,
  resolveAppearance,
} from '@openkraken/ipc-contract';
import type {
  Result,
  ServiceRequest,
  HistoryPageTransfer,
  SnapshotBodies,
  ServiceResult,
  AppearancePreferences,
  Request as DesktopRequest,
  Repository,
} from '@openkraken/ipc-contract';
import { AvatarCache } from './avatars.js';
import { SnapshotTransfer } from './snapshot-transfer.js';
import { fetchAvatar } from './avatar-provider.js';
import { isTrustedDocument, windowPreferences } from './security.js';
import { ProviderService } from './providers.js';
import { GitHubProvider, ProviderError } from './github-provider.js';
import { GitLabOAuth } from './gitlab-oauth.js';
import { GitLabProvider } from './gitlab-provider.js';
import { GitHubOAuth } from './github-device.js';
import {
  ProviderVault,
  ProviderCredentialError,
  electronSecretProtection,
} from './provider-vault.js';
const htmlPath = join(__dirname, 'renderer', 'index.html');
declare const __OPENKRAKEN_UPDATE_CONFIG__: UpdateConfiguration | null;
let updates: Updates | undefined;
let updateHandoff = false;
let installOnQuit = false;
let restartLaunch: PreparedUpdateLaunch | undefined;
let restartPreparation: AbortController | undefined;
async function cancelPreparedRestart() {
  restartPreparation?.abort();
  restartPreparation = undefined;
  const launch = restartLaunch;
  restartLaunch = undefined;
  await launch?.cancel();
}
let crashReports: CrashReports | undefined;
let diagnostics: Diagnostics | undefined;
const documentUrl = pathToFileURL(htmlPath).href;
let window: BrowserWindow | undefined;
let windowsReady = false;
function focusForLink() {
  if (!window && windowsReady) createWindow();
  if (window?.isMinimized()) window.restore();
  window?.focus();
}
const repositoryLinks = new RepositoryLinks(process.platform, () => {
  if (window && !window.isDestroyed())
    window.webContents.send(EVENT_CHANNEL, { type: 'repositoryLinkChanged' });
});
let terminalRepository: { id: string; path: string } | undefined;
const terminals = new TerminalHost((event) => {
  if (window && !window.isDestroyed()) window.webContents.send(EVENT_CHANNEL, event);
});
let service: UtilityProcess | undefined;
let avatars: AvatarCache | undefined;
let appSettings: AppSettings | undefined;
let activity: ActivityLog | undefined;
let commitDrafts: CommitDrafts | undefined;
let nativeDrafts: NativeEditorDrafts | undefined;
function nativeEditorDrafts() {
  return (nativeDrafts ??= new NativeEditorDrafts(app.getPath('userData')));
}
let workingFileDrafts: WorkingFileDrafts | undefined;
const draftRepositories = new Map<string, Repository>();
let activeAppearance: AppearancePreferences = {
  revision: 0,
  mode: 'dark',
  custom: null,
  warning: null,
};
function nativeBackground() {
  const raw = resolveAppearance(
    activeAppearance,
    nativeTheme.shouldUseDarkColors,
  ).colors.background.slice(1);
  const hex = raw.length <= 4 ? [...raw].map((char) => char + char).join('') : raw;
  const [red, green, blue] = [0, 2, 4].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
  const alpha = hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1;
  // Electron's hex alpha order differs from CSS. Functional RGBA is unambiguous.
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}
function updateWindowBackground() {
  if (window && !window.isDestroyed()) window.setBackgroundColor(nativeBackground());
}
function activateAppearance(state: AppearancePreferences) {
  activeAppearance = state;
  nativeTheme.themeSource = nativeAppearanceMode(state);
  updateWindowBackground();
}
let commandMenu: CommandMenu | undefined;
let providers: ProviderService | undefined;
const providerRequests = new Map<string, AbortController>();
const pending = new Map<
  string,
  {
    resolve: (result: ServiceResult) => void;
    timer: ReturnType<typeof setTimeout>;
    transfer?: SnapshotTransfer;
    editorRepository?: Repository;
  }
>();
function finishServiceRequest(id: string, result: ServiceResult) {
  const request = pending.get(id);
  if (!request) return;
  clearTimeout(request.timer);
  nativeDrafts?.finished(id);
  pending.delete(id);
  request.resolve(result);
}
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
    Date.now,
    new GitLabProvider(fetchProvider),
    new GitLabOAuth(fetchProvider),
    new BitbucketProvider(fetchProvider),
  ));
}
function startService() {
  const child = utilityProcess.fork(join(__dirname, 'git-service.cjs'), [app.getPath('userData')], {
    serviceName: 'OpenKraken Git',
    stdio: 'pipe',
  });
  service = child;
  child.on('message', (message) => {
    if (service !== child) return;
    if (message?.snapshotPart !== undefined) {
      const result = pending.get(message.id)?.transfer?.receive(message);
      if (result) finishServiceRequest(message.id, result);
      return;
    }
    if (message?.type === 'editorDocumentWritten') {
      const parsed = editorWrittenSchema.safeParse(message);
      if (parsed.success && pending.has(parsed.data.id))
        void nativeDrafts
          ?.written(parsed.data.id, parsed.data.promptId, parsed.data.digest)
          ?.catch(() => {});
      return;
    }
    const event = desktopEventSchema.safeParse(message);
    if (event.success) {
      // Main-owned lifecycle and UI events must never originate in the Git utility.
      if (
        event.data.type === 'gitRequestsInterrupted' ||
        event.data.type === 'repositoryLinkChanged' ||
        event.data.type === 'activityChanged' ||
        event.data.type === 'commandExecute' ||
        event.data.type === 'appearanceChanged' ||
        event.data.type === 'terminalData' ||
        event.data.type === 'terminalExit'
      )
        return;
      if (event.data.type !== 'repositoryChanged' && !pending.has(event.data.id)) return;
      if (event.data.type === 'editorPrompt') {
        const repo = pending.get(event.data.id)?.editorRepository;
        if (repo)
          nativeEditorDrafts().register(
            repo,
            event.data.id,
            event.data.promptId,
            event.data.path,
            event.data.text,
          );
      } else if (event.data.type === 'editorClosed') {
        void nativeDrafts
          ?.closed(event.data.id, event.data.promptId, event.data.reason)
          ?.catch(() => {});
      }
      if (window && !window.isDestroyed()) window.webContents.send(EVENT_CHANNEL, event.data);
      return;
    }
    const request = pending.get(message?.id);
    if (!request || message.transferId !== request.transfer?.transferId) return;
    const parsed = serviceResponseSchema.safeParse(message);
    if (!parsed.success) return;
    finishServiceRequest(parsed.data.id, parsed.data.result);
  });
  child.on('exit', () => {
    if (service !== child) return;
    service = undefined;
    interruptGitRequests([...pending.keys()]);
    for (const [id, request] of pending) {
      clearTimeout(request.timer);
      request.resolve({
        kind: 'error',
        code: 'SERVICE_EXIT',
        message:
          'The Git service stopped. The operation may have partially completed. Inspect the repository or remote before retrying.',
      });
      pending.delete(id);
    }
  });
  return child;
}
function interruptGitRequests(requestIds: string[]) {
  nativeDrafts?.interrupt(requestIds);
  if (requestIds.length && window && !window.isDestroyed())
    window.webContents.send(EVENT_CHANNEL, { type: 'gitRequestsInterrupted', requestIds });
}
function callService(request: ServiceRequest, signal?: AbortSignal): Promise<ServiceResult> {
  if (signal?.aborted) return Promise.resolve({ kind: 'cancelled' });
  const child = service ?? startService();
  const cancel = () => child.postMessage({ id: request.id });
  signal?.addEventListener('abort', cancel, { once: true });
  return new Promise<ServiceResult>((resolve) => {
    const timer = setTimeout(
      () => {
        interruptGitRequests([request.id]);
        child.postMessage({ id: request.id });
        pending.delete(request.id);
        resolve({
          kind: 'error',
          code: 'SERVICE_TIMEOUT',
          message:
            'The Git service did not respond in time. The operation may have partially completed. Inspect the repository or remote before retrying.',
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
    const transfer =
      request.method === 'open' ? new SnapshotTransfer(request.id, crypto.randomUUID()) : undefined;
    const editorRepository =
      request.method === 'interactiveRebase' || request.method === 'operationAction'
        ? draftRepositories.get(request.repoId)
        : undefined;
    pending.set(request.id, { resolve, timer, transfer, editorRepository });
    child.postMessage(transfer ? { ...request, transferId: transfer.transferId } : request);
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
function rendererFailure(reason: string) {
  diagnostics?.failure('renderer', reason);
  void crashReports?.capture('renderer', reason);
}
function createWindow(checkEntry = false) {
  window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'OpenKraken',
    backgroundColor: nativeBackground(),
    webPreferences: { ...windowPreferences, preload: join(__dirname, 'preload.cjs') },
  });
  let closing = false;
  window.on('close', () => {
    closing = true;
  });
  commandMenu = new CommandMenu(window);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-prevent-unload', (event) => {
    if (!window || window.isDestroyed()) return;
    const choice = dialog.showMessageBoxSync(window, {
      type: 'question',
      buttons: ['Keep editing', 'Discard changes'],
      defaultId: 0,
      cancelId: 0,
      title: 'Unsaved changes',
      message: 'Discard unsaved changes and close active sessions?',
      detail: 'Editor drafts may be unsaved, or a terminal session may still be running.',
      noLink: true,
    });
    if (choice === 1) {
      nativeDrafts?.detach(true);
      void workingFileDrafts?.close(undefined, true).catch(() => {});
      event.preventDefault();
    } else {
      closing = false;
      if (updateHandoff) {
        installOnQuit = false;
        void cancelPreparedRestart()
          .then(() => updates?.abandonInstall())
          .finally(() => {
            updateHandoff = false;
          });
      }
    }
  });
  const cancelProviderSignIn = () => {
    terminalRepository = undefined;
    void terminals.close();
    for (const controller of providerRequests.values()) controller.abort();
    providers?.deviceCancel();
    providers?.gitlabCancel();
  };
  window.webContents.on('render-process-gone', cancelProviderSignIn);
  window.webContents.on('preload-error', () => rendererFailure('unhandled-exception'));
  window.webContents.on('render-process-gone', (_event, details) => {
    nativeDrafts?.detach(false);
    void workingFileDrafts?.close(undefined, false);
    rendererFailure(details.reason);
  });
  window.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame) cancelProviderSignIn();
  });
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.on('closed', () => {
    nativeDrafts?.detach(false);
    terminalRepository = undefined;
    void terminals.close();
    window = undefined;
    for (const id of pending.keys()) service?.postMessage({ id });
    for (const controller of providerRequests.values()) controller.abort();
    providers?.deviceCancel();
    providers?.gitlabCancel();
  });
  const opening = window;
  return opening
    .loadFile(htmlPath)
    .then(async () => {
      if (!checkEntry || closing || opening.isDestroyed()) return;
      // A missing module or failed static import still lets Chromium finish loading the HTML.
      const evaluated = await opening.webContents.executeJavaScriptInIsolatedWorld(1001, [
        { code: 'document.querySelector("#root[data-openkraken-entry-loaded]") !== null' },
      ]);
      if (!evaluated) throw new Error('The renderer entry module did not start');
    })
    .catch((error: unknown) => {
      // Closing or reloading the window can cancel its original navigation.
      if (
        !closing &&
        !opening.isDestroyed() &&
        (error as NodeJS.ErrnoException)?.code !== 'ERR_ABORTED'
      )
        throw error;
    });
}
export function startDesktop(
  reports: CrashReports,
  reportingReady: Promise<void>,
  log: Diagnostics,
) {
  crashReports = reports;
  diagnostics = log;
  // macOS may deliver a URL before ready. No path is opened until renderer consent.
  app.on('open-url', (event, url) => {
    event.preventDefault();
    repositoryLinks.receive(url);
    focusForLink();
  });
  for (const argument of process.argv) repositoryLinks.receive(argument);
  app.on('second-instance', (_event, commandLine) => {
    for (const argument of commandLine) repositoryLinks.receive(argument);
    focusForLink();
  });
  const ready = app.whenReady().then(async () => {
    const target = await appImageTarget({
      packaged: app.isPackaged,
      platform: process.platform,
      version: app.getVersion(),
      executable: process.execPath,
      image: process.env.APPIMAGE,
      appdir: process.env.APPDIR,
    });
    updates = new Updates(join(app.getPath('userData'), 'updates'), __OPENKRAKEN_UPDATE_CONFIG__, {
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      ...(target ? { appImage: target } : {}),
    });
    await reportingReady;
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    );
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      callback({
        cancel: !details.url.startsWith(pathToFileURL(join(__dirname, 'renderer') + '/').href),
      });
    });
    const executeRequest = async (request: DesktopRequest): Promise<ServiceResult> => {
      if (request.method === 'updatesStarted')
        return { kind: 'updates', state: updatesStateSchema.parse(await updates!.started()) };
      if (request.method === 'updatesDismissRecovery') {
        try {
          return {
            kind: 'updates',
            state: updatesStateSchema.parse(await updates!.dismissRecovery()),
          };
        } catch {
          return {
            kind: 'error',
            code: 'UPDATE_RECOVERY',
            message: 'The recovery notice could not be dismissed because its storage changed.',
          };
        }
      }
      if (request.method === 'updatesAutomatic') {
        try {
          return {
            kind: 'updates',
            state: updatesStateSchema.parse(
              await updates!.setAutomatic(request.enabled, request.revision),
            ),
          };
        } catch {
          return {
            kind: 'error',
            code: 'UPDATE_SETTINGS',
            message:
              'Automatic update settings could not be saved. Refresh the dialog and check the storage warning before trying again.',
          };
        }
      }
      if (request.method === 'updatesSave') {
        try {
          const state = await updates!.save(request.saveId, async (name) => {
            if (!window || window.isDestroyed()) return;
            const result = await dialog.showSaveDialog(window, {
              title: 'Save verified installer',
              defaultPath: join(app.getPath('downloads'), name),
              filters: [{ name: 'Installer', extensions: [extname(name).slice(1)] }],
              properties: ['showOverwriteConfirmation', 'createDirectory'],
            });
            return result.canceled ? undefined : result.filePath;
          });
          return { kind: 'updates', state: updatesStateSchema.parse(state) };
        } catch {
          return {
            kind: 'error',
            code: 'UPDATE_SAVE',
            message: 'The installer save dialog could not be completed.',
          };
        }
      }
      if (request.method === 'updatesInstall') {
        const state = await updates!.read();
        if (
          updateHandoff ||
          inFlight.size > 1 ||
          pending.size ||
          providerRequests.size ||
          terminals.running
        )
          return {
            kind: 'error',
            code: 'BUSY',
            message: 'Finish active operations and close the terminal before installing an update.',
          };
        if (!state.installId || request.installId !== state.installId || !window)
          return { kind: 'updates', state };
        updateHandoff = true;
        try {
          const choice = await dialog.showMessageBox(window, {
            type: 'question',
            title: 'Install update',
            message: `Install OpenKraken ${state.version} and restart?`,
            detail: 'Save your work first. Unsaved editor changes can still prevent the restart.',
            buttons: ['Cancel', 'Install and restart'],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
          });
          if (choice.response !== 1) return { kind: 'updates', state: await updates!.read() };
          const restartHelper = await prepareUpdateRestart(
            join(app.getPath('userData'), 'updates'),
            join(
              __dirname.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1'),
              'helpers',
              'openkraken-askpass',
            ),
          );
          const prepared = await updates!.prepareInstall(request.installId);
          if (prepared.phase === 'restart-ready') {
            const plan = updates!.restartPlan();
            if (!plan) return { kind: 'updates', state: await updates!.read() };
            const preparation = new AbortController();
            restartPreparation = preparation;
            const launch = await prepareUpdateLaunch(
              restartHelper,
              plan,
              app.getPath('userData'),
              preparation.signal,
            );
            if (preparation.signal.aborted || quitState !== 'running' || !updates!.restartPlan()) {
              await launch.cancel();
              return { kind: 'updates', state: await updates!.read() };
            }
            restartLaunch = launch;
            installOnQuit = true;
            setImmediate(() => {
              if (installOnQuit && restartLaunch === launch && !preparation.signal.aborted)
                app.quit();
            });
          }
          return { kind: 'updates', state: prepared };
        } catch {
          await cancelPreparedRestart();
          await updates!.abandonInstall();
          return {
            kind: 'error',
            code: 'UPDATE_INSTALL',
            message: 'The update could not be prepared for restart.',
          };
        } finally {
          if (!installOnQuit) updateHandoff = false;
        }
      }
      if (
        request.method === 'updatesRead' ||
        request.method === 'updatesCheck' ||
        request.method === 'updatesDownload' ||
        request.method === 'updatesCancel'
      ) {
        if (request.method === 'updatesCheck') void updates!.check();
        if (request.method === 'updatesDownload') void updates!.download(request.format);
        if (request.method === 'updatesCancel') {
          const readyLaunch = restartLaunch;
          installOnQuit = false;
          await cancelPreparedRestart();
          await updates!.abandonInstall();
          // A ready launch has already returned from updatesInstall. Otherwise
          // that request still owns admission and releases it in its finally.
          if (readyLaunch) updateHandoff = false;
        }
        return { kind: 'updates', state: updatesStateSchema.parse(await updates!.read()) };
      }
      if (request.method === 'diagnosticsRead' || request.method === 'diagnosticsClear')
        return {
          kind: 'diagnostics',
          state:
            request.method === 'diagnosticsClear'
              ? await diagnostics!.clear()
              : await diagnostics!.read(),
        };
      if (request.method === 'repositoryLink')
        return { kind: 'repositoryLink', link: repositoryLinks.read() };
      if (request.method === 'repositoryLinkDismiss') {
        repositoryLinks.dismiss(request.linkId);
        return { kind: 'repositoryLink', link: repositoryLinks.read() };
      }
      // PTY acknowledgments must remain available while Git/provider requests are pending.
      if (
        request.method === 'terminalOpen' ||
        request.method === 'terminalInput' ||
        request.method === 'terminalResize' ||
        request.method === 'terminalAck' ||
        request.method === 'terminalClose'
      )
        return await terminals.request(request, terminalRepository);
      try {
        if (
          request.method === 'nativeDraftCandidates' ||
          request.method === 'nativeDraftWrite' ||
          request.method === 'nativeDraftRead' ||
          request.method === 'nativeDraftRemove' ||
          request.method === 'nativeDraftDismiss'
        ) {
          const drafts = nativeEditorDrafts();
          try {
            if (request.method === 'nativeDraftCandidates')
              return {
                kind: 'nativeDraftCandidates',
                ...(await drafts.candidates(request.requestId, request.promptId)),
              };
            if (request.method === 'nativeDraftWrite')
              await drafts.write(request.requestId, request.promptId, request.text);
            else if (request.method === 'nativeDraftDismiss')
              await drafts.dismiss(request.requestId, request.promptId, request.discard);
            else {
              const repo = draftRepositories.get(request.repoId);
              if (!repo)
                return {
                  kind: 'error',
                  code: 'UNKNOWN_REPOSITORY',
                  message: 'Open the checkout to access its drafts.',
                };
              if (request.method === 'nativeDraftRead')
                return { kind: 'nativeDraftText', ...(await drafts.read(repo, request.promptId)) };
              await drafts.remove(repo, request.promptId, request.revision);
            }
            return { kind: 'nativeDraftUpdated' };
          } catch {
            return {
              kind: 'error',
              code: 'DRAFT_UNAVAILABLE',
              message:
                'The Git editor draft is unavailable, changed elsewhere, or still open. Keep a copy of your text.',
            };
          }
        }
        if (
          request.method === 'workingDraftList' ||
          request.method === 'workingDraftOpen' ||
          request.method === 'workingDraftWrite' ||
          request.method === 'workingDraftClose'
        ) {
          const drafts = (workingFileDrafts ??= new WorkingFileDrafts(app.getPath('userData')));
          try {
            if (request.method === 'workingDraftList' || request.method === 'workingDraftOpen') {
              const repo = draftRepositories.get(request.repoId);
              if (!repo)
                return {
                  kind: 'error',
                  code: 'UNKNOWN_REPOSITORY',
                  message: 'Open the repository before accessing its draft.',
                };
              if (request.method === 'workingDraftList') {
                const [files, native] = await Promise.all([
                  drafts.list(repo),
                  nativeEditorDrafts().list(repo),
                ]);
                return {
                  kind: 'workingDraftList',
                  entries: [...files.entries, ...native.entries],
                  unreadable: files.unreadable || native.unreadable,
                };
              }
              return {
                kind: 'workingDraft',
                draft: await drafts.open(
                  repo,
                  request.pathBytes,
                  request.session,
                  request.preview,
                  request.editor,
                ),
              };
            }
            if (request.method === 'workingDraftWrite')
              await drafts.write(request.session, request.draft);
            else await drafts.close(request.session, request.discard);
            return { kind: 'workingDraft', draft: null };
          } catch {
            return {
              kind: 'error',
              code: 'DRAFT_UNAVAILABLE',
              message:
                'Local draft storage is unavailable or changed elsewhere. Keep a copy of your edits.',
            };
          }
        }
        if (request.method === 'commitDraftRead' || request.method === 'commitDraftSave') {
          const repository = draftRepositories.get(request.repoId);
          if (!repository)
            return {
              kind: 'error',
              code: 'UNKNOWN_REPOSITORY',
              message: 'Open the repository before accessing its draft.',
            };
          const drafts = (commitDrafts ??= new CommitDrafts(app.getPath('userData')));
          try {
            return {
              kind: 'commitDraft',
              state:
                request.method === 'commitDraftRead'
                  ? await drafts.read(repository)
                  : await drafts.save(repository, request.revision, request.draft),
            };
          } catch {
            return {
              kind: 'error',
              code: 'DRAFT_UNAVAILABLE',
              message:
                'Draft storage could not be read or saved, or changed elsewhere. Keep a copy of your text before restarting OpenKraken. Existing draft files were retained.',
            };
          }
        }
        if (request.method === 'activityRead' || request.method === 'activityClear')
          return {
            kind: 'activity',
            state:
              request.method === 'activityClear' ? await activity!.clear() : await activity!.read(),
          };
        if (request.method === 'commandContext') {
          commandMenu?.context(request.revision, request.available);
          return { kind: 'commandContext' };
        }
        if (request.method === 'rendererFailure') {
          rendererFailure(request.reason);
          return { kind: 'rendererFailure' };
        }
        if (request.method === 'crashReporting' || request.method === 'crashReportingSave') {
          try {
            const state =
              request.method === 'crashReportingSave'
                ? await crashReports!.save(request.enabled, request.revision)
                : await crashReports!.read();
            return { kind: 'crashReporting', state };
          } catch {
            return {
              kind: 'error',
              code: 'CRASH_REPORTING_SETTINGS',
              message:
                'Crash reporting settings could not be saved. Reopen the dialog or restart before retrying. A requested opt-out takes effect for this session even if saving fails.',
            };
          }
        }
        if (
          request.method === 'commandPreferences' ||
          request.method === 'commandKeymapSave' ||
          request.method === 'commandPreferencesMigrate' ||
          request.method === 'commandInvoked'
        ) {
          const settings = (appSettings ??= new AppSettings(app.getPath('userData')));
          try {
            const state =
              request.method === 'commandKeymapSave'
                ? await settings.save(request.keymap, request.revision)
                : request.method === 'commandPreferencesMigrate'
                  ? await settings.migrate(request.keymap, request.usage)
                  : request.method === 'commandInvoked'
                    ? await settings.record(request.command)
                    : await settings.read();
            commandMenu?.configure(state.keymap, state.revision);
            return resultSchema.parse({ kind: 'commandPreferences', state });
          } catch {
            return {
              kind: 'error',
              code: 'COMMAND_SETTINGS',
              message:
                'Command settings could not be saved. Check the keymap and settings file, then reopen the dialog or restart.',
            };
          }
        }
        if (request.method === 'appearancePreferences' || request.method === 'appearanceSave') {
          const settings = (appSettings ??= new AppSettings(app.getPath('userData')));
          try {
            const state =
              request.method === 'appearanceSave'
                ? await settings.saveAppearance(request.mode, request.revision, request.custom)
                : await settings.readAppearance();
            activateAppearance(state);
            if (request.method === 'appearanceSave' && window && !window.isDestroyed())
              window.webContents.send(EVENT_CHANNEL, { type: 'appearanceChanged', state });
            return resultSchema.parse({ kind: 'appearancePreferences', state });
          } catch {
            return {
              kind: 'error',
              code: 'APPEARANCE_SETTINGS',
              message:
                'Appearance could not be saved. Reopen Appearance or check the settings file before retrying.',
            };
          }
        }
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
          request.method === 'providerMergePreview' ||
          request.method === 'providerMergePull' ||
          request.method === 'providerPreviewPull' ||
          request.method === 'providerCreatePull' ||
          request.method === 'providerPullTemplates' ||
          request.method === 'providerPullTemplate' ||
          request.method === 'providerPullComments' ||
          request.method === 'providerCreateComment' ||
          request.method === 'providerPullChecks' ||
          request.method === 'providerWriteIssue' ||
          request.method === 'providerGitLabIssueActionPreview' ||
          request.method === 'providerWriteGitLabIssue' ||
          request.method === 'providerIssueActionPreview' ||
          request.method === 'providerIssues' ||
          request.method === 'providerIssue' ||
          request.method === 'providerIssueComments' ||
          request.method === 'providerPullFiles' ||
          request.method === 'providerPullReviews' ||
          request.method === 'providerSubmitReview' ||
          request.method === 'providerPullRequests' ||
          request.method === 'providerPullRequest' ||
          request.method === 'providerBitbucketPullRequest' ||
          request.method === 'providerBitbucketPullComments' ||
          request.method === 'providerBitbucketPullFiles' ||
          request.method === 'providerBitbucketPullDiff' ||
          request.method === 'providerMergeRequest' ||
          request.method === 'providerMergeRequestPipelines' ||
          request.method === 'providerMergeRequestPipelineJobs' ||
          request.method === 'providerMergeRequestFiles' ||
          request.method === 'providerMergeRequestDiscussions' ||
          request.method === 'providerMergeRequestMergeState' ||
          request.method === 'providerMergeRequestMergePreview' ||
          request.method === 'providerMergeRequestMerge' ||
          request.method === 'providerPreviewMergeCreation' ||
          request.method === 'providerCreateMergeRequest' ||
          request.method === 'providerMergeTemplates' ||
          request.method === 'providerMergeTemplate' ||
          request.method === 'providerMergeApprovals' ||
          request.method === 'providerMergeApprovalPreview' ||
          request.method === 'providerWriteMergeApproval' ||
          request.method === 'providerMergeDiscussionPreview' ||
          request.method === 'providerWriteMergeDiscussion' ||
          request.method === 'providerBitbucketWorkspaces' ||
          request.method === 'providerBitbucketRepositories' ||
          request.method === 'providerRepositories' ||
          request.method === 'mergeDraftRead' ||
          request.method === 'mergeDraftSave' ||
          request.method === 'mergeDraftList' ||
          request.method === 'pullDraftRead' ||
          request.method === 'pullDraftSave' ||
          request.method === 'pullDraftList' ||
          request.method === 'issueDraftRead' ||
          request.method === 'issueDraftSave' ||
          request.method === 'issueDraftList' ||
          request.method === 'reviewDraftRead' ||
          request.method === 'reviewDraftSave' ||
          request.method === 'reviewDraftList' ||
          request.method === 'providerAccounts' ||
          request.method === 'providerPollingPolicy' ||
          request.method === 'providerConnect' ||
          request.method === 'providerDisconnect' ||
          request.method === 'providerVerify' ||
          request.method === 'providerGitLabStart' ||
          request.method === 'providerGitLabPoll' ||
          request.method === 'providerGitLabOpen' ||
          request.method === 'providerGitLabCancel' ||
          request.method === 'providerDeviceStart' ||
          request.method === 'providerDevicePoll' ||
          request.method === 'providerDeviceCancel' ||
          request.method === 'providerDeviceOpen'
        ) {
          providers = getProviders();
          const controller = new AbortController();
          providerRequests.set(request.id, controller);

          if (
            request.method === 'mergeDraftRead' ||
            request.method === 'mergeDraftSave' ||
            request.method === 'mergeDraftList'
          ) {
            return await providers.mergeDraft(
              new MergeDrafts(app.getPath('userData'), electronSecretProtection(safeStorage)),
              request,
            );
          }
          if (
            request.method === 'pullDraftRead' ||
            request.method === 'pullDraftSave' ||
            request.method === 'pullDraftList'
          ) {
            return await providers.pullDraft(
              new PullDrafts(app.getPath('userData'), electronSecretProtection(safeStorage)),
              request,
            );
          }
          if (
            request.method === 'issueDraftRead' ||
            request.method === 'issueDraftList' ||
            request.method === 'issueDraftSave'
          ) {
            return await providers.issueDraft(
              new IssueDrafts(app.getPath('userData'), electronSecretProtection(safeStorage)),
              request,
            );
          }
          if (
            request.method === 'reviewDraftRead' ||
            request.method === 'reviewDraftSave' ||
            request.method === 'reviewDraftList'
          )
            return await providers.reviewDraft(
              new ReviewDrafts(app.getPath('userData'), electronSecretProtection(safeStorage)),
              request,
            );

          if (request.method === 'providerPollingPolicy')
            return resultSchema.parse({
              kind: 'providerPollingPolicy',
              policy: await providers.pollingPolicy(request.accountId),
            });

          if (request.method === 'providerMergePreview')
            return resultSchema.parse({
              kind: 'providerMergePreview',
              preview: await providers.previewMerge(
                request.accountId,
                request.options,
                controller.signal,
              ),
            });
          if (request.method === 'providerMergePull')
            return resultSchema.parse({
              kind: 'providerPullMerged',
              merge: await providers.mergePull(
                request.accountId,
                request.options,
                controller.signal,
              ),
            });
          if (request.method === 'providerPreviewPull')
            return resultSchema.parse({
              kind: 'providerPullCreationPreview',
              revision: await providers.previewPull(
                request.accountId,
                request.options,
                controller.signal,
              ),
            });
          if (request.method === 'providerCreatePull')
            return resultSchema.parse({
              kind: 'providerPullCreated',
              pullRequest: await providers.createPull(
                request.accountId,
                request.options,
                controller.signal,
              ),
            });
          if (request.method === 'providerPullTemplates')
            return resultSchema.parse({
              kind: 'providerPullTemplates',
              templates: await providers.pullTemplates(
                request.accountId,
                request.options,
                controller.signal,
              ),
            });
          if (request.method === 'providerPullTemplate')
            return resultSchema.parse({
              kind: 'providerPullTemplate',
              template: await providers.pullTemplate(
                request.accountId,
                request.options,
                controller.signal,
              ),
            });
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
          if (request.method === 'providerPullChecks')
            return resultSchema.parse({
              kind: 'providerPullChecks',
              page: await providers.pullChecks(
                request.accountId,
                request.options,
                controller.signal,
              ),
            });
          if (request.method === 'providerWriteGitLabIssue')
            return resultSchema.parse({
              kind: 'providerIssueWritten',
              result: await providers.writeGitLabIssue(
                request.accountId,
                request.options,
                controller.signal,
              ),
            });
          if (request.method === 'providerGitLabIssueActionPreview')
            return resultSchema.parse({
              kind: 'providerGitLabIssueActionPreview',
              preview: await providers.previewGitLabIssueAction(
                request.accountId,
                request.options,
                controller.signal,
              ),
            });
          if (request.method === 'providerWriteIssue')
            return resultSchema.parse({
              kind: 'providerIssueWritten',
              result: await providers.writeIssue(
                request.accountId,
                request.options,
                controller.signal,
              ),
            });
          if (request.method === 'providerIssueActionPreview')
            return resultSchema.parse({
              kind: 'providerIssueActionPreview',
              preview: await providers.previewIssueAction(
                request.accountId,
                request.options,
                controller.signal,
              ),
            });
          if (request.method === 'providerIssues')
            return resultSchema.parse({
              kind: 'providerIssues',
              page: await providers.issues(request.accountId, request.options, controller.signal),
            });
          if (request.method === 'providerIssue')
            return resultSchema.parse({
              kind: 'providerIssue',
              issue: await providers.issue(request.accountId, request.options, controller.signal),
            });
          if (request.method === 'providerIssueComments')
            return resultSchema.parse({
              kind: 'providerIssueComments',
              page: await providers.issueComments(
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
          if (request.method === 'providerBitbucketPullFiles')
            return resultSchema.parse({
              kind: 'providerBitbucketPullFiles',
              page: await providers.bitbucketPullFiles(
                request.accountId,
                request.options,
                controller.signal,
              ),
            });
          if (request.method === 'providerBitbucketPullDiff')
            return resultSchema.parse({
              kind: 'providerBitbucketPullDiff',
              diff: await providers.bitbucketPullDiff(
                request.accountId,
                request.options,
                controller.signal,
              ),
            });
          if (request.method === 'providerBitbucketPullComments')
            return resultSchema.parse({
              kind: 'providerBitbucketPullComments',
              page: await providers.bitbucketPullComments(
                request.accountId,
                request.options,
                controller.signal,
              ),
            });
          if (request.method === 'providerBitbucketPullRequest')
            return resultSchema.parse({
              kind: 'providerBitbucketPullRequest',
              pullRequest: await providers.bitbucketPullRequest(
                request.accountId,
                request.options,
                controller.signal,
              ),
            });
          if (request.method === 'providerMergeRequest')
            return resultSchema.parse({
              kind: 'providerMergeRequest',
              mergeRequest: await providers.mergeRequest(
                request.accountId,
                request.options,
                controller.signal,
              ),
            });
          if (request.method === 'providerMergeRequestPipelines')
            return resultSchema.parse({
              kind: 'providerMergeRequestPipelines',
              page: await providers.mergeRequestPipelines(
                request.accountId,
                request.options,
                controller.signal,
              ),
            });
          if (request.method === 'providerMergeRequestPipelineJobs')
            return resultSchema.parse({
              kind: 'providerMergeRequestPipelineJobs',
              page: await providers.mergeRequestPipelineJobs(
                request.accountId,
                request.options,
                controller.signal,
              ),
            });
          if (request.method === 'providerMergeRequestFiles')
            return resultSchema.parse({
              kind: 'providerMergeRequestFiles',
              page: await providers.mergeRequestFiles(
                request.accountId,
                request.options,
                controller.signal,
              ),
            });
          if (request.method === 'providerMergeRequestMergeState')
            return resultSchema.parse({
              kind: 'providerMergeRequestMergeState',
              snapshot: await providers.mergeRequestMergeState(
                request.accountId,
                request.options,
                controller.signal,
              ),
            });
          if (request.method === 'providerMergeRequestMergePreview')
            return resultSchema.parse({
              kind: 'providerMergeRequestMergePreview',
              preview: await providers.previewMergeRequestMerge(
                request.accountId,
                request.options,
                controller.signal,
              ),
            });
          if (request.method === 'providerMergeRequestMerge')
            return resultSchema.parse({
              kind: 'providerMergeRequestMerged',
              result: await providers.mergeMergeRequest(
                request.accountId,
                request.options,
                controller.signal,
              ),
            });
          if (request.method === 'providerPreviewMergeCreation')
            return resultSchema.parse({
              kind: 'providerMergeCreationPreview',
              preview: await providers.previewMergeCreation(
                request.accountId,
                request.options,
                controller.signal,
              ),
            });
          if (request.method === 'providerCreateMergeRequest')
            return resultSchema.parse({
              kind: 'providerMergeCreated',
              mergeRequest: await providers.createMergeRequest(
                request.accountId,
                request.options,
                controller.signal,
              ),
            });
          if (request.method === 'providerMergeTemplates')
            return resultSchema.parse({
              kind: 'providerMergeTemplates',
              templates: await providers.mergeTemplates(
                request.accountId,
                request.options,
                controller.signal,
              ),
            });
          if (request.method === 'providerMergeTemplate')
            return resultSchema.parse({
              kind: 'providerMergeTemplate',
              template: await providers.mergeTemplate(
                request.accountId,
                request.options,
                controller.signal,
              ),
            });
          if (request.method === 'providerMergeApprovals')
            return resultSchema.parse({
              kind: 'providerMergeApprovals',
              approvals: await providers.mergeApprovals(
                request.accountId,
                request.options,
                controller.signal,
              ),
            });
          if (request.method === 'providerMergeApprovalPreview')
            return resultSchema.parse({
              kind: 'providerMergeApprovalPreview',
              preview: await providers.previewMergeApproval(
                request.accountId,
                request.options,
                controller.signal,
              ),
            });
          if (request.method === 'providerWriteMergeApproval')
            return resultSchema.parse({
              kind: 'providerMergeApprovalWritten',
              state: await providers.writeMergeApproval(
                request.accountId,
                request.options,
                controller.signal,
              ),
            });
          if (request.method === 'providerMergeDiscussionPreview')
            return resultSchema.parse({
              kind: 'providerMergeDiscussionPreview',
              preview: await providers.previewMergeDiscussionAction(
                request.accountId,
                request.options,
                controller.signal,
              ),
            });
          if (request.method === 'providerWriteMergeDiscussion')
            return resultSchema.parse({
              kind: 'providerMergeDiscussionWritten',
              result: await providers.writeMergeDiscussion(
                request.accountId,
                request.options,
                controller.signal,
              ),
            });
          if (request.method === 'providerMergeRequestDiscussions')
            return resultSchema.parse({
              kind: 'providerMergeRequestDiscussions',
              page: await providers.mergeRequestDiscussions(
                request.accountId,
                request.options,
                controller.signal,
              ),
            });
          if (request.method === 'providerBitbucketWorkspaces')
            return resultSchema.parse({
              kind: 'providerBitbucketWorkspaces',
              page: await providers.bitbucketWorkspaces(
                request.accountId,
                request.page,
                controller.signal,
              ),
            });
          if (request.method === 'providerBitbucketRepositories')
            return resultSchema.parse({
              kind: 'providerRepositories',
              page: await providers.bitbucketRepositories(
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
          if (request.method === 'providerGitLabStart')
            return resultSchema.parse({
              kind: 'providerGitLab',
              challenge: await providers.gitlabStart(request.options, controller.signal),
            });
          if (request.method === 'providerGitLabPoll')
            return resultSchema.parse(
              await providers.gitlabPoll(request.challengeId, controller.signal),
            );
          if (request.method === 'providerGitLabOpen') {
            await shell.openExternal(providers.gitlabAuthorizationUri(request.challengeId));
            return { kind: 'providerGitLabOpened' };
          }
          if (request.method === 'providerGitLabCancel') {
            providers.gitlabCancel(request.challengeId);
            return { kind: 'cancelled' };
          }
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
        if (request.method === 'repositoryLinkOpen') {
          const path = repositoryLinks.accept(request.linkId);
          return await callService({ id: request.id, method: 'open', path });
        }
        let path: string | undefined;
        if (
          request.method === 'open' ||
          request.method === 'init' ||
          request.method === 'clone' ||
          request.method === 'addWorktree' ||
          request.method === 'discover'
        ) {
          const selected = await dialog.showOpenDialog(window!, {
            title:
              request.method === 'addWorktree'
                ? 'Create worktree in an empty folder'
                : request.method === 'clone'
                  ? 'Clone into an empty folder'
                  : request.method === 'init'
                    ? 'Initialize repository in folder'
                    : request.method === 'discover'
                      ? 'Scan for repositories'
                      : 'Open repository',
            properties: [
              'openDirectory',
              ...(['init', 'clone', 'addWorktree'].includes(request.method)
                ? ['createDirectory' as const]
                : []),
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
          request.method === 'open' ||
            request.method === 'init' ||
            request.method === 'discover' ||
            request.method === 'addWorktree'
            ? { ...request, path: path! }
            : request,
        );
      } catch (error) {
        if (
          request.method === 'providerGit' ||
          (request.method === 'clone' && !!request.providerAccountId) ||
          request.method === 'providerMergePreview' ||
          request.method === 'providerMergePull' ||
          request.method === 'providerPreviewPull' ||
          request.method === 'providerCreatePull' ||
          request.method === 'providerPullTemplates' ||
          request.method === 'providerPullTemplate' ||
          request.method === 'providerPullComments' ||
          request.method === 'providerCreateComment' ||
          request.method === 'providerPullChecks' ||
          request.method === 'providerWriteIssue' ||
          request.method === 'providerGitLabIssueActionPreview' ||
          request.method === 'providerWriteGitLabIssue' ||
          request.method === 'providerIssueActionPreview' ||
          request.method === 'providerIssues' ||
          request.method === 'providerIssue' ||
          request.method === 'providerIssueComments' ||
          request.method === 'providerPullFiles' ||
          request.method === 'providerPullReviews' ||
          request.method === 'providerSubmitReview' ||
          request.method === 'providerPullRequests' ||
          request.method === 'providerPullRequest' ||
          request.method === 'providerBitbucketPullRequest' ||
          request.method === 'providerBitbucketPullComments' ||
          request.method === 'providerBitbucketPullFiles' ||
          request.method === 'providerBitbucketPullDiff' ||
          request.method === 'providerMergeRequest' ||
          request.method === 'providerMergeRequestPipelines' ||
          request.method === 'providerMergeRequestPipelineJobs' ||
          request.method === 'providerMergeRequestFiles' ||
          request.method === 'providerMergeRequestDiscussions' ||
          request.method === 'providerMergeRequestMergeState' ||
          request.method === 'providerMergeRequestMergePreview' ||
          request.method === 'providerMergeRequestMerge' ||
          request.method === 'providerPreviewMergeCreation' ||
          request.method === 'providerCreateMergeRequest' ||
          request.method === 'providerMergeTemplates' ||
          request.method === 'providerMergeTemplate' ||
          request.method === 'providerMergeApprovals' ||
          request.method === 'providerMergeApprovalPreview' ||
          request.method === 'providerWriteMergeApproval' ||
          request.method === 'providerMergeDiscussionPreview' ||
          request.method === 'providerWriteMergeDiscussion' ||
          request.method === 'providerBitbucketWorkspaces' ||
          request.method === 'providerBitbucketRepositories' ||
          request.method === 'providerRepositories' ||
          request.method === 'mergeDraftRead' ||
          request.method === 'mergeDraftSave' ||
          request.method === 'mergeDraftList' ||
          request.method === 'pullDraftRead' ||
          request.method === 'pullDraftSave' ||
          request.method === 'pullDraftList' ||
          request.method === 'issueDraftRead' ||
          request.method === 'issueDraftSave' ||
          request.method === 'issueDraftList' ||
          request.method === 'reviewDraftRead' ||
          request.method === 'reviewDraftSave' ||
          request.method === 'reviewDraftList' ||
          request.method === 'providerAccounts' ||
          request.method === 'providerPollingPolicy' ||
          request.method === 'providerConnect' ||
          request.method === 'providerDisconnect' ||
          request.method === 'providerVerify' ||
          request.method === 'providerGitLabStart' ||
          request.method === 'providerGitLabPoll' ||
          request.method === 'providerGitLabOpen' ||
          request.method === 'providerGitLabCancel' ||
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
            ...(error instanceof ProviderError && error.retryAt !== undefined
              ? { retryAt: error.retryAt }
              : {}),
          };
        }
        return {
          kind: 'error',
          code: 'REQUEST_FAILED',
          message: error instanceof Error ? error.message : String(error),
        };
      } finally {
        providerRequests.delete(request.id);
      }
    };
    const handleRequest = async (request: DesktopRequest): Promise<ServiceResult> => {
      if (
        updateHandoff &&
        ![
          'updatesRead',
          'updatesCancel',
          'commitDraftSave',
          'reviewDraftSave',
          'issueDraftSave',
          'pullDraftSave',
          'mergeDraftSave',
          'nativeDraftWrite',
          'nativeDraftDismiss',
          'workingDraftWrite',
          'workingDraftClose',
          'terminalAck',
          'rendererFailure',
        ].includes(request.method)
      )
        return {
          kind: 'error',
          code: 'BUSY',
          message: 'An update is preparing to restart the app.',
        };
      if (
        request.method === 'terminalOpen' ||
        request.method === 'terminalInput' ||
        request.method === 'terminalResize' ||
        request.method === 'terminalAck' ||
        request.method === 'terminalClose'
      )
        return executeRequest(request);
      if (inFlight.has(request.id))
        return { kind: 'error', code: 'DUPLICATE_REQUEST', message: 'Request is already running' };
      if (inFlight.size >= 8)
        return { kind: 'error', code: 'BUSY', message: 'Too many pending operations' };
      inFlight.add(request.id);
      try {
        return await activity!.track(request, () => executeRequest(request));
      } finally {
        inFlight.delete(request.id);
        cancelled.delete(request.id);
      }
    };
    ipcMain.handle(
      CHANNEL,
      async (
        event,
        raw,
        format: unknown,
      ): Promise<Result | string | HistoryPageTransfer | SnapshotBodies> => {
        validateSender(event);
        const request = requestSchema.parse(raw);
        validateResponseFormat(format, request.method);
        const result = await diagnostics!.track(request, () => handleRequest(request));
        if (result.kind === 'snapshot' || result.kind === 'compactSnapshot') {
          terminalRepository = result.snapshot.repository;
          draftRepositories.delete(result.snapshot.repository.id);
          draftRepositories.set(result.snapshot.repository.id, result.snapshot.repository);
          if (draftRepositories.size > 128)
            draftRepositories.delete(draftRepositories.keys().next().value!);
        }
        // Serialize after validation and before both renderer IPC and isolated-world copying.
        if (format === 'history-page' && result.kind === 'page') return encodeHistoryPage(result);
        if (format === 'snapshot-bodies') return encodeSnapshotBodies(result);
        if (format === 'snapshot-transfer') return JSON.stringify(result);
        if (format === 'snapshot-json') return serializeLegacySnapshot(result);
        const expanded = expandGitServiceResult(result);
        return format === 'json' ? JSON.stringify(expanded) : expanded;
      },
    );
    ipcMain.handle(CANCEL_CHANNEL, (event, raw) => {
      validateSender(event);
      const { id } = cancelSchema.parse(raw);
      if (inFlight.has(id)) {
        cancelled.add(id);
        service?.postMessage({ id });
        providerRequests.get(id)?.abort();
      }
    });
    appSettings ??= new AppSettings(app.getPath('userData'));
    activateAppearance(await appSettings.readAppearance());
    nativeTheme.on('updated', updateWindowBackground);
    activity = new ActivityLog(app.getPath('userData'), (completed) => {
      if (window && !window.isDestroyed())
        window.webContents.send(EVENT_CHANNEL, { type: 'activityChanged', completed });
    });
    await activity.read();
    startService();
    // Native installers own protocol registration and its uninstall lifecycle.
    // Launching an extracted/portable bundle must not leave a stale registry command.
    windowsReady = true;
    const loaded = createWindow(true);
    app.on('activate', () => {
      if (!window) createWindow();
    });
    await loaded;
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  let quitState: 'running' | 'draining' | 'ready' = 'running';
  // Keep the service and caches alive if a renderer cancels the window close.
  app.on('will-quit', (event) => {
    if (quitState !== 'running') {
      if (quitState === 'draining') event.preventDefault();
      return;
    }
    const installing = installOnQuit;
    installOnQuit = false;
    const launch = installing ? restartLaunch : undefined;
    if (installing) {
      restartLaunch = undefined;
      restartPreparation = undefined;
    } else void cancelPreparedRestart();
    const installed = installing
      ? (async () => {
          try {
            if (!launch) throw new Error('Restart was not prepared');
            await launch.arm();
            const target = await updates!.commitInstall();
            if (target) launch.finishCommit();
            else await launch.cancel();
            return target;
          } catch {
            await launch?.cancel();
            await updates!.abandonInstall();
            return null;
          }
        })()
      : Promise.resolve(null);
    const updatesClosed = installed.then(() => updates?.close());
    void diagnostics?.close();
    crashReports?.close();
    avatars?.close();
    providers?.deviceCancel();
    providers?.gitlabCancel();
    for (const controller of providerRequests.values()) controller.abort();
    if (
      !service &&
      !providers &&
      !appSettings &&
      !commitDrafts &&
      !nativeDrafts &&
      !workingFileDrafts &&
      !crashReports &&
      !updates
    )
      return;
    event.preventDefault();
    quitState = 'draining';
    const child = service;
    const stopped = child
      ? new Promise<void>((resolve) => child.once('exit', () => resolve()))
      : Promise.resolve();
    const services = Promise.all([
      updatesClosed,
      stopped,
      providers?.idle(),
      appSettings?.idle(),
      crashReports?.idle(),
      diagnostics?.idle(),
      commitDrafts?.idle(),
      nativeDrafts?.idle(),
      workingFileDrafts?.idle(),
      terminals.close(),
    ]).then(() => activity?.idle());
    let serviceTimer: ReturnType<typeof setTimeout>;
    const serviceDeadline = new Promise<void>((resolve) => {
      serviceTimer = setTimeout(() => {
        if (child && service === child) {
          // UtilityProcess.kill sends SIGTERM on POSIX. A stopped service cannot
          // handle it, and has already had the full graceful shutdown interval.
          if (process.platform !== 'win32' && child.pid) {
            try {
              process.kill(child.pid, 'SIGKILL');
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill();
            }
          } else child.kill();
        }
        resolve();
      }, 1500);
    });
    const finishQuit = () => {
      if (quitState === 'ready') return;
      quitState = 'ready';
      clearTimeout(serviceTimer);
      clearTimeout(installTimer);
      // Electron ignores a reentrant quit in the original will-quit microtask.
      setImmediate(() => app.quit());
    };
    // A blocked filesystem still has a bounded exit with the armed helper and
    // journal intact. Ordinary service teardown cannot truncate a live commit.
    const installTimer = installing ? setTimeout(finishQuit, installTimeoutMs) : undefined;
    void Promise.allSettled([installed, Promise.race([services, serviceDeadline])])
      .then(([installation, cleanup]) => {
        if (!installing || quitState === 'ready') return;
        if (installation.status === 'rejected' || cleanup.status === 'rejected')
          dialog.showErrorBox(
            'Update shutdown did not finish cleanly',
            'OpenKraken could not finish all shutdown work. Retained update files remain available for recovery.',
          );
        else if (!installation.value)
          dialog.showErrorBox(
            'Update could not be installed',
            'The update was not completed. Retained update files have been left for recovery.',
          );
      })
      .finally(finishQuit);
    child?.postMessage({ shutdown: true });
  });
  return ready;
}
