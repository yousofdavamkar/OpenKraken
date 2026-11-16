import { contextBridge, ipcRenderer } from 'electron';
import {
  CHANNEL,
  CANCEL_CHANNEL,
  validateResponseFormat,
  EVENT_CHANNEL,
  desktopEventSchema,
  requestSchema,
  cancelSchema,
} from '@openkraken/ipc-contract';
import type {
  DesktopApi,
  HistoryPageRequest,
  SnapshotRequest,
  SnapshotBodies,
  HistoryPageReply,
  Request,
  Result,
} from '@openkraken/ipc-contract';
// Main validates utility responses before IPC; do not deep-clone large pages again here.
async function request(
  input: HistoryPageRequest,
  format: 'history-page',
): Promise<HistoryPageReply>;
async function request(
  input: SnapshotRequest,
  format: 'snapshot-bodies',
): Promise<SnapshotBodies | string>;
async function request(
  input: SnapshotRequest,
  format: 'snapshot-json' | 'snapshot-transfer',
): Promise<string>;
async function request(input: Request, format: 'json'): Promise<string>;
async function request(input: Request): Promise<Result>;
async function request(
  input: Request,
  format?: 'json' | 'snapshot-bodies' | 'history-page' | 'snapshot-json' | 'snapshot-transfer',
): Promise<Result | string | HistoryPageReply | SnapshotBodies> {
  const request = requestSchema.parse(input);
  validateResponseFormat(format, request.method);
  return ipcRenderer.invoke(CHANNEL, request, format);
}
const api: DesktopApi = {
  subscribe: (listener) => {
    const handler = (_event: unknown, data: unknown) => {
      const parsed = desktopEventSchema.safeParse(data);
      if (parsed.success) listener(parsed.data);
    };
    ipcRenderer.on(EVENT_CHANNEL, handler);
    return () => ipcRenderer.removeListener(EVENT_CHANNEL, handler);
  },
  request,
  cancel: async (id) => {
    await ipcRenderer.invoke(CANCEL_CHANNEL, cancelSchema.parse({ id }));
  },
};
contextBridge.exposeInMainWorld('openkraken', api);
