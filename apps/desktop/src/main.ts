import { ActivityLog } from './activity-log.js';
import { Diagnostics } from './diagnostics.js';
import { Updates } from './updates.js';
import { appImageTarget } from './appimage-target.js';
import { prepareUpdateRestart, launchUpdateAfterExit } from './update-restart.js';
import { updatesStateSchema } from '@openkraken/ipc-contract';
import { RepositoryLinks } from './repository-links.js';
import { CommitDrafts } from './commit-drafts.js';
import { CommandMenu } from './command-menu.js';
import { TerminalHost } from './terminal-host.js';
import { AppSettings } from './app-settings.js';
import { CrashReports } from './crash-reports.js';
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
  nativeAppearanceMode,
  resolveAppearance,
} from '@openkraken/ipc-contract';
import type {
  Result,
  ServiceRequest,
  AppearancePreferences,
  Request as DesktopRequest,
  Repository,
} from '@openkraken/ipc-contract';
import { AvatarCache } from './avatars.js';
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
declare const __OPENKRAKEN_SENTRY_DSN__: string | null;
declare const __OPENKRAKEN_UPDATE_CONFIG__: unknown;
let updates: Updates | undefined;
let updateHandoff = false;
let installOnQuit = false;
let restartHelper: string | undefined;
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
  if (requestIds.length && window && !window.isDestroyed())
    window.webContents.send(EVENT_CHANNEL, { type: 'gitRequestsInterrupted', requestIds });
}
function callService(request: ServiceRequest, signal?: AbortSignal): Promise<Result> {
  if (signal?.aborted) return Promise.resolve({ kind: 'cancelled' });
  const child = service ?? startService();
  const cancel = () => child.postMessage({ id: request.id });
  signal?.addEventListener('abort', cancel, { once: true });
  return new Promise<Result>((resolve) => {
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
    backgroundColor: nativeBackground(),
    webPreferences: { ...windowPreferences, preload: join(__dirname, 'preload.cjs') },
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
    if (choice === 1) event.preventDefault();
    else if (updateHandoff) {
      installOnQuit = false;
      void updates?.abandonInstall().finally(() => {
        updateHandoff = false;
      });
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
  window.webContents.on('render-process-gone', (_event, details) => {
    diagnostics?.failure('renderer', details.reason);
    void crashReports?.capture('renderer', details.reason);
  });
  window.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame) cancelProviderSignIn();
  });
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.on('closed', () => {
    terminalRepository = undefined;
    void terminals.close();
    window = undefined;
    for (const id of pending.keys()) service?.postMessage({ id });
    for (const controller of providerRequests.values()) controller.abort();
    providers?.deviceCancel();
    providers?.gitlabCancel();
  });
  void window.loadFile(htmlPath);
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  diagnostics = new Diagnostics(join(app.getPath('userData'), 'diagnostics'), {
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
  });
  // macOS may deliver a URL before ready. No path is opened until renderer consent.
  app.on('open-url', (event, url) => {
    event.preventDefault();
    repositoryLinks.receive(url);
    focusForLink();
  });
  for (const argument of process.argv) repositoryLinks.receive(argument);
  crashReports = new CrashReports(app.getPath('userData'), __OPENKRAKEN_SENTRY_DSN__, {
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
  });
  const reportingReady = crashReports.start();
  // Observe failures without replacing Node/Electron's exception handling or
  // inspecting the error object. Fatal exits are recovered through the marker.
  process.on('uncaughtExceptionMonitor', (_error, origin) => {
    diagnostics?.failure(
      'main',
      origin === 'unhandledRejection' ? 'unhandled-rejection' : 'unhandled-exception',
    );
    void crashReports?.capture(
      'main',
      origin === 'unhandledRejection' ? 'unhandled-rejection' : 'unhandled-exception',
    );
  });
  app.on('second-instance', (_event, commandLine) => {
    for (const argument of commandLine) repositoryLinks.receive(argument);
    focusForLink();
  });
  app.whenReady().then(async () => {
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
    const executeRequest = async (request: DesktopRequest): Promise<Result> => {
      if (request.method === 'updatesStarted')
        return { kind: 'updates', state: updatesStateSchema.parse(await updates!.started()) };
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
          restartHelper = await prepareUpdateRestart(
            join(app.getPath('userData'), 'updates'),
            join(
              __dirname.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1'),
              'helpers',
              'openkraken-askpass',
            ),
          );
          const prepared = await updates!.prepareInstall(request.installId);
          if (prepared.phase === 'restart-ready') {
            installOnQuit = true;
            setImmediate(() => app.quit());
          }
          return { kind: 'updates', state: prepared };
        } catch {
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
          installOnQuit = false;
          await updates!.abandonInstall();
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
          diagnostics?.failure('renderer', request.reason);
          void crashReports?.capture('renderer', request.reason);
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
    const handleRequest = async (request: DesktopRequest): Promise<Result> => {
      if (
        updateHandoff &&
        ![
          'updatesRead',
          'updatesCancel',
          'commitDraftSave',
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
    ipcMain.handle(CHANNEL, async (event, raw, format: unknown): Promise<Result | string> => {
      validateSender(event);
      if (format !== undefined && format !== 'json') throw new Error('Invalid response format');
      const request = requestSchema.parse(raw);
      const result = await diagnostics!.track(request, () => handleRequest(request));
      if (result.kind === 'snapshot') {
        terminalRepository = result.snapshot.repository;
        draftRepositories.delete(result.snapshot.repository.id);
        draftRepositories.set(result.snapshot.repository.id, result.snapshot.repository);
        if (draftRepositories.size > 128)
          draftRepositories.delete(draftRepositories.keys().next().value!);
      }
      // Serialize after validation and before both renderer IPC and isolated-world copying.
      return format === 'json' ? JSON.stringify(result) : result;
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
    appSettings ??= new AppSettings(app.getPath('userData'));
    app.on('child-process-gone', (_event, details) => {
      const kind =
        details.name === 'OpenKraken Git'
          ? 'git'
          : details.name === 'OpenKraken Terminal'
            ? 'terminal'
            : details.type === 'GPU'
              ? 'gpu'
              : null;
      if (kind) {
        diagnostics?.failure(kind, details.reason);
        void crashReports?.capture(kind, details.reason);
      }
    });
    activateAppearance(await appSettings.readAppearance());
    nativeTheme.on('updated', updateWindowBackground);
    activity = new ActivityLog(app.getPath('userData'), () => {
      if (window && !window.isDestroyed())
        window.webContents.send(EVENT_CHANNEL, { type: 'activityChanged' });
    });
    await activity.read();
    startService();
    if (process.platform === 'win32' && app.isPackaged)
      app.setAsDefaultProtocolClient('openkraken');
    windowsReady = true;
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
    const installing = installOnQuit;
    installOnQuit = false;
    const installed = installing ? updates!.commitInstall() : Promise.resolve(null);
    const updatesClosed = installed.then(() => updates?.close());
    void diagnostics?.close();
    crashReports?.close();
    avatars?.close();
    providers?.deviceCancel();
    providers?.gitlabCancel();
    for (const controller of providerRequests.values()) controller.abort();
    if (
      (!service && !providers && !appSettings && !commitDrafts && !crashReports && !updates) ||
      quitting
    )
      return;
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
    void Promise.all([
      installed,
      updatesClosed,
      stopped,
      providers?.idle(),
      appSettings?.idle(),
      crashReports?.idle(),
      diagnostics?.idle(),
      commitDrafts?.idle(),
      terminals.close(),
    ])
      .then(async ([target]) => {
        await activity?.idle();
        if (target && restartHelper)
          await launchUpdateAfterExit(restartHelper, target, app.getPath('userData'));
        else if (installing)
          dialog.showErrorBox(
            'Update could not be installed',
            'The update was not completed. Retained update files have been left for recovery.',
          );
      })
      .catch(() => {
        if (installing)
          dialog.showErrorBox(
            'Update restart failed',
            'The replacement and recovery files are retained. OpenKraken could not arrange the restart.',
          );
      })
      .finally(() => {
        clearTimeout(deadline);
        // With no live service, cleanup can finish in the original will-quit microtask.
        // Electron ignores a reentrant quit there; resume on the next event-loop turn.
        setImmediate(() => app.quit());
      });
    child?.postMessage({ shutdown: true });
  });
}
