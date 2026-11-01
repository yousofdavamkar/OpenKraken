import { contextBridge, ipcRenderer } from 'electron';
import { CHANNEL, CANCEL_CHANNEL, requestSchema, cancelSchema } from '@openkraken/ipc-contract';
import type { DesktopApi, Result } from '@openkraken/ipc-contract';
// Main validates utility responses before IPC; do not deep-clone large pages again here.
const api: DesktopApi = {
  request: async (request) =>
    (await ipcRenderer.invoke(CHANNEL, requestSchema.parse(request))) as Result,
  cancel: async (id) => {
    await ipcRenderer.invoke(CANCEL_CHANNEL, cancelSchema.parse({ id }));
  },
};
contextBridge.exposeInMainWorld('openkraken', api);
