import { app, BrowserWindow, dialog, ipcMain, utilityProcess, session } from 'electron';
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
} from '@openkraken/ipc-contract';
import type { Result, ServiceRequest } from '@openkraken/ipc-contract';
import { AvatarCache } from './avatars.js';
import { fetchAvatar } from './avatar-provider.js';
import { isTrustedDocument, windowPreferences } from './security.js';
const htmlPath = join(__dirname, 'renderer', 'index.html');
const documentUrl = pathToFileURL(htmlPath).href;
let window: BrowserWindow | undefined;
let service: UtilityProcess | undefined;
let avatars: AvatarCache | undefined;
const pending = new Map<
  string,
  { resolve: (result: Result) => void; timer: ReturnType<typeof setTimeout> }
>();
const inFlight = new Set<string>();
const cancelled = new Set<string>();
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
function callService(request: ServiceRequest): Promise<Result> {
  const child = service ?? startService();
  return new Promise((resolve) => {
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
      request.method === 'clone'
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
              ].includes(request.method)
            ? 210000
            : request.method === 'commit' || request.method === 'reference'
              ? 180000
              : 60000,
    );
    pending.set(request.id, { resolve, timer });
    child.postMessage(request);
  });
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
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.on('closed', () => {
    window = undefined;
    for (const id of pending.keys()) service?.postMessage({ id });
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
        return await callService(
          request.method === 'open' ||
            request.method === 'init' ||
            request.method === 'discover' ||
            request.method === 'clone'
            ? { ...request, path: path! }
            : request,
        );
      } catch (error) {
        return {
          kind: 'error',
          code: 'REQUEST_FAILED',
          message: error instanceof Error ? error.message : String(error),
        };
      } finally {
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
  app.on('before-quit', (event) => {
    avatars?.close();
    if (!service || quitting) return;
    event.preventDefault();
    quitting = true;
    const child = service;
    const deadline = setTimeout(() => {
      child.kill();
      app.quit();
    }, 1500);
    child.once('exit', () => {
      clearTimeout(deadline);
      app.quit();
    });
    child.postMessage({ shutdown: true });
  });
}
