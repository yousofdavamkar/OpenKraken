import { contextBridge, ipcRenderer } from 'electron';
import {
  CHANNEL,
  CANCEL_CHANNEL,
  requestSchema,
  resultSchema,
  cancelSchema,
} from '@openkraken/ipc-contract';
import type { DesktopApi } from '@openkraken/ipc-contract';
const api: DesktopApi = {
  request: async (request) =>
    resultSchema.parse(await ipcRenderer.invoke(CHANNEL, requestSchema.parse(request))),
  cancel: async (id) => {
    await ipcRenderer.invoke(CANCEL_CHANNEL, cancelSchema.parse({ id }));
  },
};
contextBridge.exposeInMainWorld('openkraken', api);
